"use client";

/**
 * Case bar — the durable work-product layer for live mode.
 *
 *   저장   snapshot the current investigation into a saved Case
 *   케이스  list / re-open / delete saved cases
 *   리포트  auto-drafted intel product (BLUF · IOC table · coverage gaps)
 *          + the analyst's written judgement, exportable as Markdown
 *
 * The report is generated from the CURRENT live graph, so it always reflects
 * what's on screen. The written assessment persists onto the active case.
 */

import { useCallback, useEffect, useState } from "react";

import type { GraphEdge, GraphNode } from "@/lib/stealthgraph";
import {
  deleteCase,
  getCase,
  listCases,
  saveCase,
  updateCase,
  type Assessment,
  type CaseSummary,
  type FireLogEntry,
} from "@/lib/stealthgraph-live";

const TYPE_KO: Record<string, string> = {
  email: "이메일", ip: "IP", domain: "도메인", url: "URL",
  handle: "핸들", telegram: "텔레그램", wallet: "지갑",
  tox: "TOX", hash: "파일해시", xmpp: "XMPP", invite: "초대링크",
};

type NodeClass = "anchor" | "traded" | "neutral";

function classify(n: GraphNode, trusted: boolean): NodeClass {
  const rf = n.reuse_factor;
  const queried = n.breadth && Object.keys(n.breadth).length > 0;
  if (rf != null && rf < 0.6) return "traded";
  if (trusted || (rf != null && rf >= 0.6 && queried)) return "anchor";
  return "neutral";
}

type Report = {
  seed: string;
  machineCount: number;
  identifierCount: number;
  strong: GraphNode[];
  traded: GraphNode[];
  coverage: { code: string; fires: number; hits: number; zero: number }[];
  iocs: { value: string; type: string; trusted: boolean; cls: NodeClass }[];
};

function buildReport(
  nodes: GraphNode[],
  fireLog: FireLogEntry[],
  trustedIds: Set<string>,
  seed: string
): Report {
  const machines = nodes.filter((n) => n.type === "ip");
  const strong: GraphNode[] = [];
  const traded: GraphNode[] = [];
  const iocs: Report["iocs"] = [];
  for (const n of nodes) {
    const t = trustedIds.has(n.id);
    const cls = classify(n, t);
    if (cls === "anchor") strong.push(n);
    else if (cls === "traded") traded.push(n);
    iocs.push({ value: n.label, type: n.type, trusted: t, cls });
  }
  // coverage from the fire log — negative (0-result) fires are intel too
  const cov = new Map<string, { fires: number; hits: number; zero: number }>();
  for (const f of fireLog) {
    if (f.kind !== "fired" || !f.module) continue;
    const c = cov.get(f.module) ?? { fires: 0, hits: 0, zero: 0 };
    c.fires++;
    if ((f.total ?? 0) > 0) c.hits++;
    else c.zero++;
    cov.set(f.module, c);
  }
  const order: NodeClass[] = ["anchor", "traded", "neutral"];
  iocs.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls));
  return {
    seed,
    machineCount: machines.length,
    identifierCount: nodes.length,
    strong,
    traded,
    coverage: [...cov.entries()].map(([code, c]) => ({ code, ...c })),
    iocs,
  };
}

function reportMarkdown(title: string, r: Report, a: Assessment): string {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push(`_생성 ${now} · 시드 ${r.seed}_`, "");
  lines.push("## 개요 (BLUF)");
  lines.push(a.bluf?.trim() || "_(미작성)_", "");
  lines.push(`- 관측 식별자 **${r.identifierCount}개**, 감염 기기 **${r.machineCount}대**`);
  lines.push(`- 강한 앵커(고유·신뢰): ${r.strong.map((n) => n.label).join(", ") || "—"}`);
  lines.push(`- 거래 재고/약한 링크: ${r.traded.map((n) => n.label).join(", ") || "—"}`);
  if (a.confidence?.trim()) lines.push("", `**신뢰도:** ${a.confidence.trim()}`);
  lines.push("", "## IOC");
  lines.push("| 유형 | 지표 | 분류 | 신뢰 |", "|---|---|---|---|");
  for (const i of r.iocs) {
    const cls = i.cls === "anchor" ? "앵커" : i.cls === "traded" ? "거래재고" : "—";
    lines.push(`| ${TYPE_KO[i.type] ?? i.type} | \`${i.value}\` | ${cls} | ${i.trusted ? "✓" : ""} |`);
  }
  lines.push("", "## 커버리지 · 공백");
  if (r.coverage.length) {
    for (const c of r.coverage) {
      lines.push(`- **${c.code}** ${c.fires}회 조회 · 적중 ${c.hits} · 0건 ${c.zero}`);
    }
    lines.push("- _0건 결과 = 해당 채널에 이 행위자 흔적 없음(가시성 사각)._");
  } else {
    lines.push("- _조회 이력 없음._");
  }
  lines.push("", "## 권고 · 조치");
  lines.push(a.recommendations?.trim() || "_(미작성)_");
  return lines.join("\n");
}

// ============================================================================

export function CaseBar({
  nodes,
  edges,
  fireLog,
  trustedIds,
  seed,
  signedIn,
  onOpenCase,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fireLog: FireLogEntry[];
  trustedIds: Set<string>;
  seed: string;
  signedIn: boolean;
  onOpenCase: (id: string) => Promise<void>;
}) {
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string>("");
  const [assessment, setAssessment] = useState<Assessment>({});
  const [showList, setShowList] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  void edges;

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 2600);
  };

  const doSave = useCallback(async () => {
    if (!signedIn) return flash("저장하려면 coders.kr 로그인 필요");
    if (!nodes.length) return flash("빈 조사 — 먼저 시드를 투입하세요");
    const title = window.prompt("사건 제목", activeTitle || "무제 사건");
    if (!title) return;
    setBusy(true);
    try {
      const res = await saveCase(title);
      setActiveCaseId(res.id);
      setActiveTitle(res.title);
      flash("케이스 저장됨");
    } catch (e) {
      flash(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }, [signedIn, nodes.length, activeTitle]);

  const refreshList = useCallback(async () => {
    try {
      setCases(await listCases());
    } catch {
      setCases([]);
    }
  }, []);

  useEffect(() => {
    if (showList) refreshList();
  }, [showList, refreshList]);

  const doOpen = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const full = await getCase(id);
        await onOpenCase(id);
        setActiveCaseId(id);
        setActiveTitle(full.title);
        setAssessment(full.assessment ?? {});
        setShowList(false);
        flash(`'${full.title}' 열림`);
      } catch (e) {
        flash(e instanceof Error ? e.message : "열기 실패");
      } finally {
        setBusy(false);
      }
    },
    [onOpenCase]
  );

  const doDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("이 케이스를 삭제할까요?")) return;
      await deleteCase(id).catch(() => {});
      if (activeCaseId === id) {
        setActiveCaseId(null);
        setActiveTitle("");
      }
      refreshList();
    },
    [activeCaseId, refreshList]
  );

  const saveAssessment = useCallback(async () => {
    if (!activeCaseId) return flash("먼저 케이스를 저장하세요");
    await updateCase(activeCaseId, { assessment }).catch(() => {});
    flash("판단 저장됨");
  }, [activeCaseId, assessment]);

  const report = buildReport(nodes, fireLog, trustedIds, seed);

  const btn =
    "rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40";

  return (
    <>
      <div className="flex items-center gap-1.5">
        {activeTitle && (
          <span className="max-w-[120px] truncate font-mono text-[10px] text-[color:var(--muted-foreground)]" title={activeTitle}>
            📁 {activeTitle}
          </span>
        )}
        <button className={btn} style={{ background: "var(--muted)" }} onClick={doSave} disabled={busy}>
          저장
        </button>
        <button className={btn} style={{ background: "var(--muted)" }} onClick={() => setShowList(true)}>
          케이스
        </button>
        <button
          className={btn}
          style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
          onClick={() => setShowReport(true)}
        >
          리포트
        </button>
      </div>

      {toast && (
        <div
          className="fixed left-1/2 top-3 z-[200] -translate-x-1/2 rounded-md border px-3 py-1.5 text-[12px] shadow-lg"
          style={{ background: "var(--panel-2)", borderColor: "var(--border-strong)" }}
        >
          {toast}
        </div>
      )}

      {showList && (
        <Modal title="저장된 사건철" onClose={() => setShowList(false)}>
          {cases.length === 0 ? (
            <p className="text-[12px] text-[color:var(--muted-foreground)]">
              저장된 케이스가 없습니다.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {cases.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-md border p-2.5"
                  style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium">{c.title}</div>
                    <div className="font-mono text-[10px] text-[color:var(--muted-foreground)]">
                      {c.seed} · {c.nodes}노드 · {c.updated_at.slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                  <button className={btn} style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
                    onClick={() => doOpen(c.id)} disabled={busy}>
                    열기
                  </button>
                  <button className={btn} style={{ background: "var(--muted)", color: "var(--danger)" }}
                    onClick={() => doDelete(c.id)}>
                    삭제
                  </button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {showReport && (
        <Modal title={`인텔 리포트 — ${activeTitle || "미저장 조사"}`} onClose={() => setShowReport(false)} wide>
          <ReportView
            report={report}
            assessment={assessment}
            setAssessment={setAssessment}
            onSaveAssessment={saveAssessment}
            markdown={() => reportMarkdown(activeTitle || "무제 사건", report, assessment)}
            onFlash={flash}
          />
        </Modal>
      )}
    </>
  );
}

function ReportView({
  report,
  assessment,
  setAssessment,
  onSaveAssessment,
  markdown,
  onFlash,
}: {
  report: Report;
  assessment: Assessment;
  setAssessment: (a: Assessment) => void;
  onSaveAssessment: () => void;
  markdown: () => string;
  onFlash: (m: string) => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      onFlash("Markdown 복사됨");
    } catch {
      onFlash("복사 실패");
    }
  };
  const download = () => {
    const blob = new Blob([markdown()], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stealthgraph-report.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  const field = (label: string, key: keyof Assessment, rows: number, ph: string) => (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
        {label}
      </div>
      <textarea
        rows={rows}
        value={assessment[key] ?? ""}
        onChange={(e) => setAssessment({ ...assessment, [key]: e.target.value })}
        placeholder={ph}
        className="sg-scroll w-full resize-y rounded-md border p-2 text-[12px] leading-relaxed"
        style={{ background: "var(--panel-2)", borderColor: "var(--border)", color: "var(--foreground)" }}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* analyst assessment — the human judgement */}
      <div className="flex flex-col gap-3 rounded-md border p-3" style={{ borderColor: "var(--border-strong)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold" style={{ color: "var(--violet)" }}>분석관 판단 (직접 작성)</span>
          <button className="rounded px-2 py-1 text-[11px]" style={{ background: "var(--muted)" }} onClick={onSaveAssessment}>
            판단 저장
          </button>
        </div>
        {field("개요 (BLUF)", "bluf", 3, "핵심 판단 한두 문장 — 누가, 무엇을, 얼마나 확신.")}
        {field("신뢰도", "confidence", 1, "예: 중~상 — 클린 앵커 존재하나 실명 미확립.")}
        {field("권고 · 조치", "recommendations", 3, "차단할 IOC, 통보 대상, 이첩 여부, 추가 수집.")}
      </div>

      {/* auto-generated evidence summary */}
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <Stat n={report.identifierCount} label="관측 식별자" />
        <Stat n={report.machineCount} label="감염 기기(IP)" />
        <Stat n={report.strong.length} label="강한 앵커(고유·신뢰)" tone="var(--good)" />
        <Stat n={report.traded.length} label="거래 재고/약한 링크" tone="var(--amber)" />
      </div>

      <div>
        <SectionLabel>IOC</SectionLabel>
        <div className="sg-scroll max-h-[220px] overflow-y-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-[11px]">
            <thead className="sticky top-0" style={{ background: "var(--panel-2)" }}>
              <tr className="text-[color:var(--muted-foreground)]">
                <th className="px-2 py-1 text-left font-medium">유형</th>
                <th className="px-2 py-1 text-left font-medium">지표</th>
                <th className="px-2 py-1 text-left font-medium">분류</th>
                <th className="px-2 py-1 text-center font-medium">신뢰</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {report.iocs.map((i, k) => (
                <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-2 py-1 text-[color:var(--muted-foreground)]">{TYPE_KO[i.type] ?? i.type}</td>
                  <td className="px-2 py-1">{i.value}</td>
                  <td className="px-2 py-1">
                    {i.cls === "anchor" ? (
                      <span style={{ color: "var(--good)" }}>앵커</span>
                    ) : i.cls === "traded" ? (
                      <span style={{ color: "var(--amber)" }}>거래재고</span>
                    ) : (
                      <span className="text-[color:var(--muted-foreground)]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-center" style={{ color: "var(--good)" }}>{i.trusted ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <SectionLabel>커버리지 · 공백</SectionLabel>
        {report.coverage.length ? (
          <div className="flex flex-col gap-1 text-[11.5px]">
            {report.coverage.map((c) => (
              <div key={c.code} className="flex items-center gap-2">
                <span className="font-mono font-semibold" style={{ minWidth: 40 }}>{c.code}</span>
                <span className="text-[color:var(--muted-foreground)]">
                  {c.fires}회 · 적중 {c.hits} · <span style={{ color: c.zero ? "var(--amber)" : undefined }}>0건 {c.zero}</span>
                </span>
              </div>
            ))}
            <p className="mt-1 text-[10.5px] text-[color:var(--muted-foreground)]">
              0건 결과 = 해당 채널(콤보·텔레그램 등)에 이 행위자 흔적 없음 — 가시성 사각.
            </p>
          </div>
        ) : (
          <p className="text-[11.5px] text-[color:var(--muted-foreground)]">조회 이력 없음.</p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <button className="rounded px-3 py-1.5 text-[11px]" style={{ background: "var(--muted)" }} onClick={copy}>
          Markdown 복사
        </button>
        <button
          className="rounded px-3 py-1.5 text-[11px] font-medium"
          style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
          onClick={download}
        >
          .md 다운로드
        </button>
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="rounded-md border p-2" style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}>
      <div className="font-mono text-[18px] font-semibold" style={{ color: tone ?? "var(--foreground)" }}>{n}</div>
      <div className="text-[10.5px] text-[color:var(--muted-foreground)]">{label}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
      {children}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="sg-scroll flex max-h-[88vh] w-full flex-col overflow-y-auto rounded-xl border shadow-2xl"
        style={{ maxWidth: wide ? 640 : 460, background: "var(--panel)", borderColor: "var(--border-strong)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <h3 className="text-[13px] font-semibold">{title}</h3>
          <button className="text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]" onClick={onClose}>✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
