"use client";

/**
 * STEALTHGRAPH — the whole investigation console in one client component.
 *
 * Left panel (탐색 설정 / 가설 tabs) · center graph + timeline · right
 * inspector. Fusion lives in the backend; this component owns the live
 * configuration (seed, timeline asof, ablated modules + weights), the
 * θ threshold (client-only — recomputes clusters/tiers without a fetch),
 * and the analyst's trust state (localStorage v3 + best-effort DB sync).
 */

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { GraphCanvas, PALETTE } from "@/components/GraphCanvas";
import { useMe, signInHref, signOutHref } from "@/lib/identity";
import {
  fetchBeliefs,
  fetchGraph,
  fetchMeta,
  putBelief,
  type BeliefBlob,
  type GraphEdge,
  type GraphNode,
  type GraphResponse,
  type Meta,
  type ModuleInfo,
  type NodeType,
} from "@/lib/stealthgraph";
import {
  compareLiveNodes,
  fetchLiveMeta,
  fetchLiveState,
  fireLiveModule,
  openCase,
  resetLiveSession,
  seedLiveIdentifier,
  type FireLogEntry,
  type LiveMeta,
  type LiveState,
  type Quotas,
} from "@/lib/stealthgraph-live";
import { CaseBar } from "@/components/Cases";
import {
  activeTrustByCat,
  computeViews,
  emptyBlob,
  loadTrust,
  rootsFrom,
  saveTrust,
  uid,
  type NodeView,
  type TrustState,
} from "@/lib/trust";

type Mode = "demo" | "live";
type LeftTab = "explore" | "quests" | "hypotheses";

const TYPE_LABEL: Record<NodeType, string> = {
  handle: "핸들",
  email: "이메일",
  wallet: "지갑",
  telegram: "텔레그램",
  device: "기기",
  pgp: "PGP 키",
  ip: "IP",
  forum: "포럼",
  domain: "도메인",
  url: "URL",
  tox: "TOX",
  hash: "파일해시",
  xmpp: "XMPP",
  invite: "초대링크",
};

const CAT_COLORS = [
  "#a78bfa",
  "#34d399",
  "#f5b942",
  "#57c7ff",
  "#e084c4",
  "#f5a97f",
];

// StealthMole 모듈 코드 → 풀네임 + 한 줄 설명 (툴팁용). 쿼터 스트립은 노출
// 모듈 7개 외에 DT/CDF 사용량도 함께 반환하므로 9개 전부 포함한다.
const SM_MODULE_INFO: Record<string, { name: string; desc: string }> = {
  DT: {
    name: "Darkweb Tracker",
    desc: "다크웹·딥웹의 콘텐츠·사이트·서비스를 수집·검색.",
  },
  TT: {
    name: "Telegram Tracker",
    desc: "텔레그램 채널·그룹·유저·메시지에서 노출/범죄 연관 정황을 탐색.",
  },
  CL: {
    name: "Credential Lookout",
    desc: "이메일·도메인 기준으로 계정 크리덴셜의 외부 유출 여부를 점검.",
  },
  CDF: {
    name: "Compromised Data File",
    desc: "스틸러 로그·유출 아카이브의 침해 문서·파일 내용을 파싱·분석.",
  },
  CDS: {
    name: "Compromised Dataset",
    desc: "스틸러 감염 기기의 유출 데이터 — 로그인 사이트·계정·비번·감염 IP·사용자명·컴퓨터명.",
  },
  CB: {
    name: "Combo Binder",
    desc: "ID:Password 조합(콤보리스트) 유출 탐지. credential stuffing·계정 재사용 위험 분석.",
  },
  RM: {
    name: "Ransomware Monitoring",
    desc: "랜섬웨어 유출 사이트의 피해 노출을 모니터링.",
  },
  GM: {
    name: "Government Monitoring",
    desc: "정부기관 관련 유출·노출을 모니터링.",
  },
  LM: {
    name: "Leak Monitoring",
    desc: "기업 유출·노출을 모니터링.",
  },
};

function fmtDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toISOString().slice(0, 10);
}

// ---- investigation quests (live mode) ---------------------------------
// Curated real-data cases framed as objective-driven missions. Objectives
// auto-tick from live graph/fire-log/trust state — no manual checkoff.

type QuestCtx = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fireLog: FireLogEntry[];
  trustedCount: number;
};

type Quest = {
  id: string;
  tag: string;
  title: string;
  tagline: string;
  briefing: string;
  seed: string;
  objectives: { id: string; label: string; done: (c: QuestCtx) => boolean }[];
  resolved: string;
};

// objective predicates over live graph/fire-log state
const cdsFired = (c: QuestCtx) =>
  c.fireLog.some((f) => f.kind === "fired" && f.module === "CDS");
const cdsFiredTwice = (c: QuestCtx) =>
  c.fireLog.filter((f) => f.kind === "fired" && f.module === "CDS").length >= 2;
const ipCount = (c: QuestCtx) => c.nodes.filter((n) => n.type === "ip").length;
// analyst pulled a reuse-breadth signal (fired CB/CL on some identifier)
const breadthChecked = (c: QuestCtx) =>
  c.nodes.some((n) => n.breadth && (n.breadth.cb != null || n.breadth.cl != null));
// a shared identifier was exposed as widely-traded inventory (weak anchor)
const tradedFound = (c: QuestCtx) =>
  c.nodes.some((n) => (n.reuse_factor ?? 1) < 0.6);

const QUESTS: Quest[] = [
  {
    id: "ghost-trader",
    tag: "실데이터 · 다기기 · Kenya",
    title: "유령 트레이더",
    tagline: "한 기기의 계정들 — 일부는 2번째 기기로 샌다. 진짜는 누구?",
    briefing:
      "프롭펌 펀디드 계정 사기 운영자. 감염 기기 한 대에 계정이 잔뜩이지만, " +
      "일부 이메일은 CDS로 되짚으면 2번째 감염 기기로 이어진다. 어느 게 운영자의 진짜 신원이고 " +
      "어느 게 널리 거래되는 재고 크리덴셜인지 CB 재사용폭으로 판별해 실체를 확정하라.",
    seed: "ip:154.153.177.120",
    objectives: [
      { id: "infil", label: "침투 — 감염 기기 시드 (ip:154.153.177.120)", done: (c) => c.nodes.some((n) => n.label === "154.153.177.120") },
      { id: "dump", label: "압수 — CDS로 기기 덤프 확보", done: cdsFired },
      { id: "bridge", label: "다기기 브리지 — 이메일을 CDS로 되짚어 2번째 기기(ip) 발견", done: (c) => ipCount(c) >= 2 },
      { id: "breadth", label: "판별 — 후보를 CB로 조회해 재사용폭(재고 vs 신원) 확인", done: breadthChecked },
      { id: "resolve", label: "해소 — 진짜 신원 5개 이상 신뢰 귀속", done: (c) => c.trustedCount >= 5 },
    ],
    resolved:
      "해소 완료 — 재사용폭으로 재고 크리덴셜을 걷어내고 운영자의 진짜 다기기 신원을 확정. " +
      "살아있는 펀디드 계정·결제 레일은 프롭펌/PSP에 신고 가능(조치).",
  },
  {
    id: "back-alley",
    tag: "실데이터 · 대조군 · savastan0",
    title: "뒷골목 만물상",
    tagline: "치트·드랍십핑·카딩 — 브리지 없는 자기완결형.",
    briefing:
      "게임 치트·드랍십핑·카딩을 한 대에서 굴리는 잡범. 앞선 사건들과 달리 다른 기기로 새는 " +
      "브리지가 거의 없는 자기완결형 케이스다 — '모든 게 연결되진 않는다'의 기준선. " +
      "한 기기 안에서 계정들을 확정하라.",
    seed: "ip:165.166.116.60",
    objectives: [
      { id: "infil", label: "침투 — 감염 기기 시드 (ip:165.166.116.60)", done: (c) => c.nodes.some((n) => n.label === "165.166.116.60") },
      { id: "dump", label: "압수 — CDS로 기기 덤프 확보", done: cdsFired },
      { id: "scale", label: "규모 파악 — 식별자 12개 이상 점등", done: (c) => c.nodes.length >= 12 },
      { id: "breadth", label: "검증 — 계정 하나를 CL/CB로 조회해 재사용폭 확인", done: breadthChecked },
      { id: "resolve", label: "해소 — 식별자 5개 이상 신뢰 귀속", done: (c) => c.trustedCount >= 5 },
    ],
    resolved:
      "해소 완료 — 브리지 없는 자기완결 운영자로 확정. 결제·마켓플레이스 계정은 각 플랫폼에 어뷰징 신고 가능(조치).",
  },
  {
    id: "market-recon",
    tag: "실데이터 · 발견형 · 러시안마켓",
    title: "시장 정찰",
    tagline: "물린 기기 수천 대 중, 운영자급 한 대를 골라내라.",
    briefing:
      "타겟을 '발견'하는 임무. seed로 크리덴셜 마켓 도메인을 넣으면 이 마켓에 물린 감염 기기 표본이 뜬다. " +
      "그 중 감염 기기(ip)를 골라 CDS로 파고들어 운영자급 실체를 특정하라. " +
      "— 앞선 임무들의 타겟을 어떻게 찾았는지, 그 방법 자체가 이번 과제다.",
    seed: "domain:russianmarket.to",
    objectives: [
      { id: "recon", label: "정찰 — 마켓 도메인 시드 (domain:russianmarket.to)", done: (c) => c.nodes.some((n) => n.label === "russianmarket.to") },
      { id: "sample", label: "표본 확보 — CDS로 감염 기기 표본 조회", done: cdsFired },
      { id: "candidates", label: "후보 식별 — 식별자 12개 이상 점등", done: (c) => c.nodes.length >= 12 },
      { id: "deepdive", label: "심층 — 감염 기기(ip)를 CDS로 재조회 (2번째 CDS)", done: cdsFiredTwice },
      { id: "resolve", label: "해소 — 식별자 5개 이상 신뢰 귀속", done: (c) => c.trustedCount >= 5 },
    ],
    resolved:
      "발견 완료 — 마켓 표본에서 운영자급 기기를 특정하고 실체를 해소. 이 워크플로가 다른 타겟을 찾아낸 방법이다.",
  },
  {
    id: "ghost-citizen",
    tag: "실데이터 · 합성신원 + 함정 · 가나",
    title: "유령 시민",
    tagline: "한 기기에 모인 지메일 십수 개 — 몇 개가 진짜인가?",
    briefing:
      "미국 신원도용 운영자. 한 감염 기기에 지메일이 십수 개 모여 작명 패턴으로 자동 군집한다. " +
      "전부 운영자의 것일까? 그 중엔 2번째 기기로 새어나가 '다기기 운영자'처럼 보이는 미끼가 섞여 있다. " +
      "CB 재사용폭으로 '널리 거래된 재고'를 걸러내고, 운영자가 직접 찍어낸 진짜 신원 군집만 남겨 실체를 확정하라.",
    seed: "ip:154.161.32.177",
    objectives: [
      { id: "infil", label: "침투 — 감염 기기 시드 (ip:154.161.32.177)", done: (c) => c.nodes.some((n) => n.label === "154.161.32.177") },
      { id: "dump", label: "압수 — CDS 덤프 (합성 신원이 작명 패턴으로 자동 군집)", done: cdsFired },
      { id: "factory", label: "공장 확인 — 식별자 12개 이상 점등", done: (c) => c.nodes.length >= 12 },
      { id: "trap", label: "함정 판별 — 후보를 CB로 조회해 '거래 재고' 노드 적발", done: tradedFound },
      { id: "resolve", label: "해소 — 진짜 합성신원 5개 이상 신뢰 귀속", done: (c) => c.trustedCount >= 5 },
    ],
    resolved:
      "해소 완료 — 재고 크리덴셜(함정)을 걷어내고 운영자가 찍어낸 합성 신원 군집만 단일 실체로 확정. " +
      "id.me·IRS·대출기관에 신원도용 신고 가능(조치).",
  },
  {
    id: "darkstar",
    tag: "실데이터 · 가명→실명 · 캐나다",
    title: "다크스타",
    tagline: "가명 'd4rkst4r' · 기기명 'Russia 34' — 뒤에 누가 있나?",
    briefing:
      "캐나다 은행 사기 운영자가 가명 'd4rkst4r'와 기기명 'Russia 34'(러시아인 위장) 뒤에 숨어 있다. " +
      "화려한 핸들이 진짜 정체일까? 감염 기기를 털어 계정들을 드러내고, 하나를 되짚어 2번째 기기로 잇고, " +
      "CB 재사용폭으로 '널리 거래된 미끼'와 '드문 진짜 앵커'를 갈라내 그의 실체를 밝혀라.",
    seed: "ip:161.20.145.77",
    objectives: [
      { id: "infil", label: "침투 — 감염 기기 시드 (ip:161.20.145.77)", done: (c) => c.nodes.some((n) => n.label === "161.20.145.77") },
      { id: "dump", label: "압수 — CDS 덤프 (계정들이 작명 패턴으로 자동 군집)", done: cdsFired },
      { id: "bridge", label: "브리지 — 이메일을 CDS로 되짚어 2번째 기기(ip) 발견", done: (c) => ipCount(c) >= 2 },
      { id: "breadth", label: "앵커 판별 — 후보들을 CB로 조회해 미끼 vs 진짜 앵커 판별", done: breadthChecked },
      { id: "resolve", label: "해소 — 진짜 앵커로 실체 5개 이상 신뢰 귀속", done: (c) => c.trustedCount >= 5 },
    ],
    resolved:
      "해소 완료 — 화려한 가명(d4rkst4r, CB 대량유통)은 약한 미끼였고, 진짜 앵커는 드문 실명 Billy Vienneau. " +
      "가명→실명 역익명화 + 2개 기기·xss.is 포럼 연계까지 단일 실체로 확정(조치).",
  },
  {
    id: "broker-tox",
    tag: "실데이터 · 텔레그램 · Indonesia",
    title: "가면 뒤의 브로커",
    tagline: "핸들은 지워도 연락처는 못 지운다 — TOX 하나로 계정 11개를 잇는다.",
    briefing:
      "인도네시아 정부·통신 대량유출(#TelkomIndonesiaOperation)을 판 데이터 브로커. " +
      "핸들 @lockbituser는 이미 삭제됐고 서포트 계정은 전부 소모품(burner)이라, 개인 식별자로는 벽에 막힌다. " +
      "그러나 손님이 연락할 TOX 키는 못 바꾼다 — 그 하나를 시드로 넣으면 흩어진 채널·계정이 한 운영으로 묶인다. " +
      "이어서 파일해시(유포망)와 초대링크(정체교체)로 확장하고, 이름만 겹치는 GANOSEC 링크는 문체 비교로 반증하라.",
    seed: "tox:022A7EEB83B648F55DA7A6BEFD130C2156C74F3501A31D853234EC2D18E77A1E48F333F07F9E",
    objectives: [
      { id: "seed", label: "시드 — 연락처(TOX) 투입", done: (c) => c.nodes.some((n) => n.type === "tox") },
      { id: "cluster", label: "확장 — TT fire로 계정 클러스터 점등(10+)", done: (c) => c.nodes.filter((n) => n.type === "telegram").length >= 10 },
      { id: "anchor2", label: "교차 앵커 — hash 또는 invite 시드로 유포망·정체교체 확장", done: (c) => c.nodes.some((n) => n.type === "hash" || n.type === "invite") },
      { id: "refute", label: "반증 — 의심 엣지에 🔬 문체 비교 실행", done: (c) => c.fireLog.some((f) => f.kind === "compared") },
      { id: "resolve", label: "해소 — 실체 5개 이상 신뢰 귀속", done: (c) => c.trustedCount >= 5 },
    ],
    resolved:
      "해소 완료 — 삭제된 핸들·소모품 계정으로 개인신원은 막혔지만, 안 바뀌는 TOX 연락키가 채널 7·유저 4를 단일 운영으로 결속. " +
      "파일해시·초대링크로 유포망과 정체교체(2번째 TOX)까지 관통. GANOSEC은 문체(상업판매 vs 핵티비즘)가 달라 반증 — 이름 차용으로 확정.",
  },
];

// ---- recorded blind-investigation replays --------------------------------
// Each step drives the REAL live graph (seed / fire / trust). Fires are
// session-memoized so replaying costs no extra API calls; numbers in the
// narration are the actual captured results. This is the analyst's move-by-
// move solve, played back so you watch the graph resolve itself.

type ReplayAction =
  | { kind: "seed"; query: string }
  | { kind: "fire"; module: string; target: string } // target = node label
  | { kind: "compare"; a: string; b: string } // a, b = node labels (문체 비교)
  | { kind: "trust"; targets: string[] }
  | { kind: "note" };
type ReplayStep = { move: string; narrate: string; action: ReplayAction };

const REPLAYS: Record<string, ReplayStep[]> = {
  "broker-tox": [
    { move: "진입 · TOX", narrate: "핸들 @lockbituser는 삭제됐고 서포트 계정은 전부 소모품(burner). 개인 식별자로는 벽. 하지만 손님이 연락할 TOX 키는 못 바꾼다 — 그 하나를 시드로.",
      action: { kind: "seed", query: "tox:022A7EEB83B648F55DA7A6BEFD130C2156C74F3501A31D853234EC2D18E77A1E48F333F07F9E" } },
    { move: "결속 · TT", narrate: "TT로 이 TOX를 광고하는 계정을 전부 소환. 채널 7·유저 4가 tox_reuse(0.9·저위조)로 단일 운영에 결속 — 흩어진 11개가 하나로.",
      action: { kind: "fire", module: "tt", target: "022A7EEB83B648F55DA7A6BEFD130C2156C74F3501A31D853234EC2D18E77A1E48F333F07F9E" } },
    { move: "유포망 · 파일해시", narrate: "다른 앵커 — 유출 파일의 지문(sha256). TOX가 못 잡은 미러·재배포 통로까지 확장한다.",
      action: { kind: "seed", query: "hash:457091d005392421047028ede0bfc28ace25eba7fad45dacbe134752c76a3986" } },
    { move: "유포망 · TT", narrate: "파일해시로 유포망 소환 — file_reuse 8채널. 유포 ≠ 통제: 재배포·미러도 함께 걸린다(노드 역할 구분 필요).",
      action: { kind: "fire", module: "tt", target: "457091d005392421047028ede0bfc28ace25eba7fad45dacbe134752c76a3986" } },
    { move: "의심 링크", narrate: "클러스터의 한 계정이 'GANOSEC TEAM' 이름을 달았다. 같은 팀? 이름만 빌린 것? — 표시이름 하나로 결속하는 건 성급하다.",
      action: { kind: "seed", query: "GANOSEC" } },
    { move: "의심 링크 · TT", narrate: "GANOSEC 전용 채널을 소환해 실체를 확인한다.",
      action: { kind: "fire", module: "tt", target: "GANOSEC" } },
    { move: "반증 · 문체", narrate: "브로커 채널 vs GANOSEC 채널의 문체를 🔬 비교. 상업 대량판매(FILE INFORMATION·VIP·Tox ID) vs 웹디페이스 핵티비즘(#OPISRAEL·Hacked by) — 완전히 다르다. stylometry raw 0.14 → 링크 반증(다른 주체). 이름 차용으로 확정.",
      action: { kind: "compare", a: "2313176825", b: "1445615189" } },
    { move: "해소", narrate: "결론 — 개인신원은 삼중 OPSEC(소모품 계정·TOX 교체·크리덴셜 미재사용)에 막혔지만, TOX 연락키가 운영을 단일 실체로 결속. GANOSEC은 반증. 운영 지문으로 귀속(조치).",
      action: { kind: "trust", targets: ["2313176825", "1990185227", "2327094259", "2695950096", "2356544496", "2327000977", "2395682241"] } },
  ],
  darkstar: [
    { move: "침투", narrate: "감염 기기 하나. 주인이 누군지 모른다. CDS로 통째로 턴다.",
      action: { kind: "seed", query: "ip:161.20.145.77" } },
    { move: "압수 · CDS", narrate: "덤프 4,478건. 계정들이 작명 패턴으로 자동 군집(handle_similarity 16). 화려한 핸들 d4rkst4r와 밋밋한 이름 billyvienneau가 같이 보인다 — 누가 진짜 주인인가?",
      action: { kind: "fire", module: "cds", target: "161.20.145.77" } },
    { move: "브리지 · CDS", narrate: "billyvienneau를 되짚으니 2번째 감염 기기 142.163.154.40 등장. 이 이름이 기기 2대에 걸쳐 있다 → 진짜 신원 후보.",
      action: { kind: "fire", module: "cds", target: "billyvienneau420@icloud.com" } },
    { move: "판별 · CB(가명)", narrate: "화려한 핸들부터 검증. CB=480 — 콤보리스트에 도배된 오염 크리덴셜. 기기 연결 확률 0.90 → 0.28로 붕괴. 눈에 띄지만 미끼다.",
      action: { kind: "fire", module: "cb", target: "d4rkst4r17@hotmail.com" } },
    { move: "판별 · CB(실명)", narrate: "실명 검증. CB=3 — 드묾. 연결 확률 0.98 유지. 이게 그를 유일하게 가리키는 진짜 앵커.",
      action: { kind: "fire", module: "cb", target: "billyvienneau420@icloud.com" } },
    { move: "해소", narrate: "결론: d4rkst4r 뒤의 실체는 Billy Vienneau. 미끼를 걷어내고 실명 군집·기기 2대를 단일 실체로 귀속.",
      action: { kind: "trust", targets: ["161.20.145.77", "142.163.154.40", "billyvienneau420@icloud.com", "billyvienneau4200@hotmail.com", "billyvienneau780@gmail.com", "bluevienneau7@gmail.com"] } },
  ],
  "ghost-trader": [
    { move: "침투", narrate: "프롭펌 사기 의심 기기. CDS로 턴다.",
      action: { kind: "seed", query: "ip:154.153.177.120" } },
    { move: "압수 · CDS", narrate: "덤프 61건, 30노드. 케냐계 이름 다수 + 러시안마켓·프롭펌 계정 수십 개.",
      action: { kind: "fire", module: "cds", target: "154.153.177.120" } },
    { move: "브리지 · CDS", narrate: "pesiankolian을 되짚으니 2번째 기기 105.163.1.73(메타트레이더+버너폰+송금). 다기기 운영자.",
      action: { kind: "fire", module: "cds", target: "pesiankolian@gmail.com" } },
    { move: "판별 · CB", narrate: "CB=14 — 다소 거래됨. 연결 확률 0.995 → 0.905로 할인. 완전 재고는 아니고, 약하지만 그의 신원.",
      action: { kind: "fire", module: "cb", target: "pesiankolian@gmail.com" } },
    { move: "해소", narrate: "재고를 걷어내고 운영자의 진짜 다기기 신원으로 귀속.",
      action: { kind: "trust", targets: ["154.153.177.120", "105.163.1.73", "pesiankolian@gmail.com", "jameskikwati@gmail.com", "kangetheian1@gmail.com", "ernestmweti@gmail.com"] } },
  ],
  "ghost-citizen": [
    { move: "침투", narrate: "신원도용 의심 기기(사용자 'Stan'). CDS로 턴다.",
      action: { kind: "seed", query: "ip:154.161.32.177" } },
    { move: "압수 · CDS", narrate: "덤프 78건. 공식으로 찍어낸 듯한 지메일 다수(ern.wet91·liz.wet91·new.bra82…)가 작명 패턴으로 자동 군집. 합성 신원 공장이다.",
      action: { kind: "fire", module: "cds", target: "154.161.32.177" } },
    { move: "브리지 · CDS", narrate: "그 중 larbiayisi가 2번째 기기 197.251.178.137(포렉스 스캠)로 샌다 — 같은 운영자가 두 사업? 아니면 함정?",
      action: { kind: "fire", module: "cds", target: "larbiayisi@gmail.com" } },
    { move: "함정 · CB", narrate: "larbiayisi 검증: CB=5 — 콤보리스트에 유통되는 거래 재고. 서로 다른 사람이 우연히 같이 가졌을 수 있어 두 사업 합치기 주의(함정).",
      action: { kind: "fire", module: "cb", target: "larbiayisi@gmail.com" } },
    { move: "대조 · CB", narrate: "합성 신원 검증: ern.wet91은 CB=0 — 어디에도 없는 운영자 자작. 이게 진짜 그의 군집.",
      action: { kind: "fire", module: "cb", target: "ern.wet91@gmail.com" } },
    { move: "해소", narrate: "재고(larbiayisi)를 걷어내고 자작 합성 신원 군집만 단일 실체로 귀속.",
      action: { kind: "trust", targets: ["154.161.32.177", "ern.wet91@gmail.com", "liz.wet91@gmail.com", "new.bra82@gmail.com", "nor.geo82@gmail.com", "gg.dly187@gmail.com"] } },
  ],
  "back-alley": [
    { move: "침투", narrate: "잡범 의심 기기(사용자 'genow'). CDS로 턴다.",
      action: { kind: "seed", query: "ip:165.166.116.60" } },
    { move: "압수 · CDS", narrate: "덤프 374건, 30노드. arhmad 계정군 + 게임 치트·드랍십핑·카딩.",
      action: { kind: "fire", module: "cds", target: "165.166.116.60" } },
    { move: "브리지 확인 · CDS", narrate: "계정 하나를 되짚어도 2번째 기기가 안 나온다(ip 1개). 다른 기기로 새지 않는다.",
      action: { kind: "fire", module: "cds", target: "arhmad@me.com" } },
    { move: "판정", narrate: "브리지 없는 자기완결형. 툴이 억지로 잇지 않는다는 걸 보여주는 대조군.",
      action: { kind: "note" } },
    { move: "해소", narrate: "한 기기 안에서 계정 군집을 단일 실체로 귀속.",
      action: { kind: "trust", targets: ["165.166.116.60", "arhmad@me.com", "arhmaddates3@gmail.com", "arhmaddates5@gmail.com", "arhmaddates6@gmail.com", "arhmadj@gmail.com"] } },
  ],
  "market-recon": [
    { move: "정찰", narrate: "타겟을 '발견'하는 임무. 크리덴셜 마켓 도메인을 시드로.",
      action: { kind: "seed", query: "domain:russianmarket.to" } },
    { move: "표본 · CDS", narrate: "마켓에 물린 감염 기기 표본. ip 후보 여럿(109.148.61.211, 154.153.177.120, 223.123.36.72, 46.124.147.19). 참고로 154.153.177.120은 '유령 트레이더' 바로 그 기기다.",
      action: { kind: "fire", module: "cds", target: "russianmarket.to" } },
    { move: "심층 · CDS", narrate: "후보 기기 하나를 파고드니 219건 덤프·39노드. 운영자급 규모.",
      action: { kind: "fire", module: "cds", target: "109.148.61.211" } },
    { move: "발견", narrate: "마켓 표본 → 기기 피벗으로 타겟을 발견한다. 다른 사건들도 이 방법으로 찾았다.",
      action: { kind: "note" } },
    { move: "해소", narrate: "발견한 운영자급 기기·후보들을 실체로 귀속.",
      action: { kind: "trust", targets: ["russianmarket.to", "109.148.61.211", "154.153.177.120", "223.123.36.72", "46.124.147.19"] } },
  ],
};

export function StealthGraph() {
  const me = useMe();
  const [mode, setMode] = useState<Mode>("demo");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [seed, setSeed] = useState<string>("h_kes1");
  const [asof, setAsof] = useState<number | null>(null);
  const [theta, setTheta] = useState(0.75);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("explore");
  const [leftW, setLeftW] = useState(300);
  const [rightW, setRightW] = useState(340);

  // ---- live (real StealthMole data) mode state ----
  const [liveMeta, setLiveMeta] = useState<LiveMeta | null>(null);
  const [liveGraph, setLiveGraph] = useState<LiveState | null>(null);
  const [liveSeedInput, setLiveSeedInput] = useState("");
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [activeQuestId, setActiveQuestId] = useState<string | null>(null);

  // trust state (all seeds) + current seed's blob
  const [trust, setTrust] = useState<TrustState>({});
  const blob: BeliefBlob = trust[seed] ?? emptyBlob();

  // ---- boot: meta + trust ----
  useEffect(() => {
    fetchMeta().then((m) => {
      setMeta(m);
      setSeed(m.default_seed);
      setAsof(m.time.default);
    });
    fetchLiveMeta().then(setLiveMeta).catch(() => setLiveMeta(null));
  }, []);

  useEffect(() => {
    const local = loadTrust();
    setTrust(local);
    // best-effort DB merge for seeds the browser hasn't seen
    fetchBeliefs().then((db) => {
      setTrust((cur) => {
        const merged = { ...cur };
        for (const [s, b] of Object.entries(db)) {
          const has = merged[s];
          if (!has || (has.categories?.length ?? 0) === 0) merged[s] = b;
        }
        return merged;
      });
    });
  }, [me]);

  // ---- fetch graph on config change (θ excluded — pure client) ----
  // In live mode this ONLY re-fuses whatever StealthMole evidence has
  // already been fetched (/api/live/state never calls StealthMole search
  // itself) — scrubbing θ/ablation here never spends rate-limit budget.
  // Only seedLiveIdentifier/fireLiveModule (explicit button clicks) do.
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode === "demo") {
      if (asof == null) return;
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      setLoading(true);
      fetchTimer.current = setTimeout(() => {
        fetchGraph(seed, asof, { disabled, weights })
          .then((g) => setGraph(g))
          .finally(() => setLoading(false));
      }, 90);
    } else {
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      setLoading(true);
      fetchTimer.current = setTimeout(() => {
        fetchLiveState(disabled, weights)
          .then((g) => setLiveGraph(g))
          .finally(() => setLoading(false));
      }, 90);
    }
    return () => {
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
    };
  }, [mode, seed, asof, disabled, weights]);

  // ---- persist trust (localStorage now, DB debounced) ----
  const dbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(
    (next: TrustState, changedSeed: string) => {
      setTrust(next);
      saveTrust(next);
      if (dbTimer.current) clearTimeout(dbTimer.current);
      const b = next[changedSeed];
      if (b) {
        dbTimer.current = setTimeout(() => putBelief(changedSeed, b), 500);
      }
    },
    []
  );

  const modules = meta?.modules ?? [];
  const nodes = useMemo(
    () => (mode === "live" ? (liveGraph?.nodes ?? []) : (graph?.nodes ?? [])),
    [mode, liveGraph, graph]
  );
  const edges = useMemo(
    () => (mode === "live" ? (liveGraph?.edges ?? []) : (graph?.edges ?? [])),
    [mode, liveGraph, graph]
  );

  // ---- live-only actions: each is exactly one explicit user action ----
  const runSeed = useCallback(
    async (query: string): Promise<boolean> => {
      const q = query.trim();
      if (!q || liveBusy) return false;
      setLiveBusy(true);
      setLiveError(null);
      try {
        const res = await seedLiveIdentifier(q);
        setLiveGraph(res);
        if (res.seed) {
          setSeed(res.seed);
          setSelectedId(res.seed);
        }
        return true;
      } catch (e) {
        setLiveError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setLiveBusy(false);
      }
    },
    [liveBusy]
  );

  const submitLiveSeed = useCallback(async () => {
    const ok = await runSeed(liveSeedInput);
    if (ok) setLiveSeedInput("");
  }, [runSeed, liveSeedInput]);

  const startQuest = useCallback(
    async (quest: Quest) => {
      setActiveQuestId(quest.id);
      await runSeed(quest.seed);
    },
    [runSeed]
  );

  const fireLive = useCallback(
    async (moduleId: string, nodeId: string) => {
      if (liveBusy) return;
      setLiveBusy(true);
      setLiveError(null);
      try {
        const res = await fireLiveModule(moduleId, nodeId, disabled, weights);
        setLiveGraph(res);
      } catch (e) {
        setLiveError(e instanceof Error ? e.message : String(e));
      } finally {
        setLiveBusy(false);
      }
    },
    [disabled, weights, liveBusy]
  );

  // adversarial verify an edge — drill both accounts, compare writing style,
  // emit a stylometry observation (negative if they diverge).
  const compareLive = useCallback(
    async (a: string, b: string) => {
      if (liveBusy) return;
      setLiveBusy(true);
      setLiveError(null);
      try {
        const res = await compareLiveNodes(a, b, disabled, weights);
        setLiveGraph(res);
      } catch (e) {
        setLiveError(e instanceof Error ? e.message : String(e));
      } finally {
        setLiveBusy(false);
      }
    },
    [disabled, weights, liveBusy]
  );

  const resetLive = useCallback(async () => {
    if (liveBusy) return;
    setLiveBusy(true);
    try {
      const res = await resetLiveSession();
      setLiveGraph(res);
      setSelectedId(null);
    } finally {
      setLiveBusy(false);
    }
  }, [liveBusy]);

  // ---- recorded replay engine ----
  const [replay, setReplay] = useState<
    { questId: string; step: number; total: number; move: string; narrate: string } | null
  >(null);
  const stopReplay = useRef(false);

  // Trust a set of nodes (by label) under a given seed — functional setState
  // so it's safe to call from the async replay loop without stale `seed`.
  const trustNodesFor = useCallback(
    (seedKey: string, labels: string[], nodesNow: GraphNode[]) => {
      const ids = labels
        .map((l) => nodesNow.find((n) => n.label === l)?.id)
        .filter(Boolean) as string[];
      if (!ids.length) return;
      setTrust((prev) => {
        let b = prev[seedKey] ?? emptyBlob();
        let catId = b.activeCats.find((c) => b.categories.some((k) => k.id === c));
        if (!catId) {
          catId = uid();
          b = {
            categories: [...b.categories, { id: catId, label: "가설 A", color: CAT_COLORS[0] }],
            trustByCat: { ...b.trustByCat, [catId]: [] },
            activeCats: [...b.activeCats, catId],
          };
        }
        const set = new Set(b.trustByCat[catId] ?? []);
        ids.forEach((id) => set.add(id));
        const nextBlob: BeliefBlob = { ...b, trustByCat: { ...b.trustByCat, [catId]: [...set] } };
        const next = { ...prev, [seedKey]: nextBlob };
        saveTrust(next);
        putBelief(seedKey, nextBlob);
        return next;
      });
    },
    []
  );

  const runReplay = useCallback(
    async (quest: Quest) => {
      const steps = REPLAYS[quest.id];
      if (!steps || replay) return;
      setMode("live");
      setActiveQuestId(quest.id);
      setSelectedId(null);
      stopReplay.current = false;
      let state: LiveState;
      setLiveBusy(true);
      try {
        state = await resetLiveSession();
        setLiveGraph(state);
      } finally {
        setLiveBusy(false);
      }
      for (let i = 0; i < steps.length; i++) {
        if (stopReplay.current) break;
        const s = steps[i];
        setReplay({ questId: quest.id, step: i, total: steps.length, move: s.move, narrate: s.narrate });
        const a = s.action;
        try {
          if (a.kind === "seed") {
            setLiveBusy(true);
            state = await seedLiveIdentifier(a.query);
            setLiveGraph(state);
            if (state.seed) { setSeed(state.seed); setSelectedId(state.seed); }
            setLiveBusy(false);
          } else if (a.kind === "fire") {
            const node = state.nodes.find((n) => n.label === a.target);
            if (node) {
              setSelectedId(node.id);
              setLiveBusy(true);
              state = await fireLiveModule(a.module, node.id, disabled, weights);
              setLiveGraph(state);
              setLiveBusy(false);
            }
          } else if (a.kind === "compare") {
            const na = state.nodes.find((n) => n.label === a.a);
            const nb = state.nodes.find((n) => n.label === a.b);
            if (na && nb) {
              setSelectedId(na.id);
              setLiveBusy(true);
              state = await compareLiveNodes(na.id, nb.id, disabled, weights);
              setLiveGraph(state);
              setLiveBusy(false);
            }
          } else if (a.kind === "trust" && state.seed) {
            trustNodesFor(state.seed, a.targets, state.nodes);
          }
        } catch (e) {
          setLiveError(e instanceof Error ? e.message : String(e));
          setLiveBusy(false);
        }
        if (stopReplay.current) break;
        await new Promise((r) => setTimeout(r, a.kind === "fire" || a.kind === "compare" ? 3000 : 2300));
      }
      if (!stopReplay.current) await new Promise((r) => setTimeout(r, 600));
      setReplay(null);
    },
    [replay, disabled, weights, trustNodesFor]
  );

  const stopReplayNow = useCallback(() => {
    stopReplay.current = true;
    setReplay(null);
  }, []);

  // reopen a saved case: rehydrate the server session, then pull it into view
  const onOpenCase = useCallback(
    async (id: string) => {
      setMode("live");
      await openCase(id);
      const st = await fetchLiveState(disabled, weights);
      setLiveGraph(st);
      if (st.seed) {
        setSeed(st.seed);
        setSelectedId(null);
      }
    },
    [disabled, weights]
  );

  // ---- derived trust view ----
  const roots = useMemo(() => rootsFrom(blob, seed), [blob, seed]);
  const views = useMemo<Map<string, NodeView>>(
    () =>
      computeViews(nodes, edges, roots, theta, activeTrustByCat(blob)),
    [nodes, edges, roots, theta, blob]
  );
  const seedClusterId = views.get(seed)?.cluster ?? null;
  const clusterCount = useMemo(() => {
    const s = new Set<number>();
    for (const n of nodes) {
      const v = views.get(n.id);
      if (v && v.tier !== "hidden") s.add(v.cluster);
    }
    return s.size;
  }, [nodes, views]);
  const seedClusterSize = useMemo(
    () =>
      nodes.filter((n) => views.get(n.id)?.cluster === seedClusterId).length,
    [nodes, views, seedClusterId]
  );

  // distinct identifiers trusted into the active hypotheses (drives quest
  // "해소" objective + hypothesis panel)
  const trustedIds = useMemo(() => {
    const s = new Set<string>();
    for (const ids of Object.values(activeTrustByCat(blob))) {
      for (const id of ids) s.add(id);
    }
    return s;
  }, [blob]);
  const trustedCount = trustedIds.size;

  const questCtx: QuestCtx = useMemo(
    () => ({ nodes, edges, fireLog: liveGraph?.fire_log ?? [], trustedCount }),
    [nodes, edges, liveGraph, trustedCount]
  );
  const activeQuest = QUESTS.find((q) => q.id === activeQuestId) ?? null;

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  // ---- trust mutations ----
  function ensurePrimaryCat(b: BeliefBlob): [BeliefBlob, string] {
    const active = b.activeCats.filter((c) =>
      b.categories.some((k) => k.id === c)
    );
    if (active.length) return [b, active[0]];
    if (b.categories.length) {
      const id = b.categories[0].id;
      return [{ ...b, activeCats: [...b.activeCats, id] }, id];
    }
    const id = uid();
    const cat = {
      id,
      label: "가설 A",
      color: CAT_COLORS[0],
    };
    return [
      {
        categories: [cat],
        trustByCat: { ...b.trustByCat, [id]: [] },
        activeCats: [id],
      },
      id,
    ];
  }

  const toggleTrust = useCallback(
    (nodeId: string, catId?: string) => {
      let b = trust[seed] ?? emptyBlob();
      let cat = catId;
      if (!cat) {
        [b, cat] = ensurePrimaryCat(b);
      }
      const list = b.trustByCat[cat] ?? [];
      const has = list.includes(nodeId);
      const nextList = has
        ? list.filter((x) => x !== nodeId)
        : [...list, nodeId];
      const nextBlob: BeliefBlob = {
        ...b,
        trustByCat: { ...b.trustByCat, [cat]: nextList },
      };
      persist({ ...trust, [seed]: nextBlob }, seed);
    },
    [trust, seed, persist]
  );

  const addCategory = useCallback(() => {
    const b = trust[seed] ?? emptyBlob();
    const id = uid();
    const idx = b.categories.length;
    const cat = {
      id,
      label: `가설 ${String.fromCharCode(65 + idx)}`,
      color: CAT_COLORS[idx % CAT_COLORS.length],
    };
    persist(
      {
        ...trust,
        [seed]: {
          categories: [...b.categories, cat],
          trustByCat: { ...b.trustByCat, [id]: [] },
          activeCats: [...b.activeCats, id],
        },
      },
      seed
    );
  }, [trust, seed, persist]);

  const deleteCategory = useCallback(
    (catId: string) => {
      const b = trust[seed] ?? emptyBlob();
      const restTrust = { ...b.trustByCat };
      delete restTrust[catId];
      persist(
        {
          ...trust,
          [seed]: {
            categories: b.categories.filter((c) => c.id !== catId),
            trustByCat: restTrust,
            activeCats: b.activeCats.filter((c) => c !== catId),
          },
        },
        seed
      );
    },
    [trust, seed, persist]
  );

  const toggleActiveCat = useCallback(
    (catId: string) => {
      const b = trust[seed] ?? emptyBlob();
      const has = b.activeCats.includes(catId);
      persist(
        {
          ...trust,
          [seed]: {
            ...b,
            activeCats: has
              ? b.activeCats.filter((c) => c !== catId)
              : [...b.activeCats, catId],
          },
        },
        seed
      );
    },
    [trust, seed, persist]
  );

  const resetSeedTrust = useCallback(() => {
    persist({ ...trust, [seed]: emptyBlob() }, seed);
  }, [trust, seed, persist]);

  // ---- Space toggles trust on the selected node ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && selectedId) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        e.preventDefault();
        toggleTrust(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, toggleTrust]);

  // ---- module ablation controls ----
  const toggleModule = (key: string) =>
    setDisabled((d) => {
      const n = new Set(d);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const setModuleWeight = (key: string, w: number) =>
    setWeights((prev) => ({ ...prev, [key]: w }));

  // ---- panel resize ----
  const startResize = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const raw = side === "left" ? startW + dx : startW - dx;
      const clamped = Math.max(220, Math.min(600, raw));
      if (side === "left") setLeftW(clamped);
      else setRightW(clamped);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!meta || (mode === "demo" && asof == null)) {
    return (
      <div className="flex h-screen items-center justify-center text-[color:var(--muted-foreground)]">
        엔진 초기화 중…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        me={me}
        mode={mode}
        onMode={(m) => {
          setMode(m);
          setSelectedId(null);
          // the 임무 tab only exists in live mode — fall back to 탐색 설정
          if (m === "demo" && leftTab === "quests") setLeftTab("explore");
        }}
        seeds={meta.seeds}
        seed={seed}
        onSeed={(s) => {
          setSeed(s);
          setSelectedId(null);
        }}
        loading={loading}
        liveSeedInput={liveSeedInput}
        onLiveSeedInput={setLiveSeedInput}
        onLiveSeedSubmit={submitLiveSeed}
        onLiveReset={resetLive}
        liveBusy={liveBusy}
        liveConfigured={liveMeta?.configured ?? false}
        quotas={liveGraph?.quotas ?? null}
        caseBar={
          mode === "live" ? (
            <CaseBar
              nodes={nodes}
              edges={edges}
              fireLog={liveGraph?.fire_log ?? []}
              trustedIds={trustedIds}
              seed={liveGraph?.seed ? `${nodes.find((n) => n.id === liveGraph.seed)?.type ?? "?"}:${nodes.find((n) => n.id === liveGraph.seed)?.label ?? ""}` : "—"}
              signedIn={me != null}
              onOpenCase={onOpenCase}
            />
          ) : null
        }
      />
      <div className="flex min-h-0 flex-1">
        {/* LEFT */}
        <aside
          className="sg-scroll flex flex-col overflow-y-auto border-r"
          style={{ width: leftW, background: "var(--panel)" }}
        >
          <LeftTabs mode={mode} tab={leftTab} onTab={setLeftTab} />
          {leftTab === "explore" ? (
            <ExplorePanel
              mode={mode}
              theta={theta}
              onTheta={setTheta}
              clusterCount={clusterCount}
              seedClusterSize={seedClusterSize}
              modules={modules}
              disabled={disabled}
              weights={weights}
              onToggleModule={toggleModule}
              onWeight={setModuleWeight}
              onReset={resetSeedTrust}
              onDemo={(action) =>
                applyDemo(action, {
                  setTheta,
                  setDisabled,
                  setAsof,
                  time: meta.time,
                  setSelectedId,
                })
              }
            />
          ) : leftTab === "quests" ? (
            <QuestPanel
              quests={QUESTS}
              activeQuestId={activeQuestId}
              ctx={questCtx}
              disabled={!(liveMeta?.configured ?? false) || liveBusy}
              onStart={startQuest}
              onStop={() => setActiveQuestId(null)}
              onReplay={runReplay}
              replaying={replay != null}
            />
          ) : (
            <HypothesisPanel
              blob={blob}
              nodes={nodes}
              onAdd={addCategory}
              onDelete={deleteCategory}
              onToggleActive={toggleActiveCat}
            />
          )}
        </aside>
        <Resizer onPointerDown={startResize("left")} />

        {/* CENTER */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              views={views}
              theta={theta}
              selectedId={selectedId}
              seedClusterId={seedClusterId}
              onSelect={setSelectedId}
            />
            <Legend />
            {mode === "live" && activeQuest && (
              <QuestTracker
                quest={activeQuest}
                ctx={questCtx}
                onClose={() => setActiveQuestId(null)}
              />
            )}
            {replay && <ReplayBar replay={replay} onStop={stopReplayNow} />}
          </div>
          {mode === "demo" && asof != null && (
            <Timeline time={meta.time} asof={asof} onAsof={setAsof} />
          )}
        </main>
        <Resizer onPointerDown={startResize("right")} />

        {/* RIGHT */}
        <aside
          className="sg-scroll overflow-y-auto border-l"
          style={{ width: rightW, background: "var(--panel)" }}
        >
          <Inspector
            selected={selected}
            view={selectedId ? views.get(selectedId) ?? null : null}
            edges={edges}
            nodes={nodes}
            roots={roots}
            blob={blob}
            asof={asof}
            transfer={mode === "demo" ? meta.time.transfer : null}
            onToggleTrust={toggleTrust}
            live={
              mode === "live"
                ? {
                    queryable: selectedId ? liveGraph?.queryable[selectedId] ?? null : null,
                    onFire: fireLive,
                    onCompare: compareLive,
                    busy: liveBusy,
                    configured: liveMeta?.configured ?? false,
                    lastFire: liveGraph?.last_fire ?? null,
                    error: liveError,
                  }
                : null
            }
          />
        </aside>
      </div>
    </div>
  );
}

// ============================ TOP BAR ============================

function TopBar({
  me,
  mode,
  onMode,
  seeds,
  seed,
  onSeed,
  loading,
  liveSeedInput,
  onLiveSeedInput,
  onLiveSeedSubmit,
  onLiveReset,
  liveBusy,
  liveConfigured,
  quotas,
  caseBar,
}: {
  me: ReturnType<typeof useMe>;
  mode: Mode;
  onMode: (m: Mode) => void;
  seeds: Meta["seeds"];
  seed: string;
  onSeed: (s: string) => void;
  loading: boolean;
  liveSeedInput: string;
  onLiveSeedInput: (v: string) => void;
  onLiveSeedSubmit: () => void;
  onLiveReset: () => void;
  liveBusy: boolean;
  liveConfigured: boolean;
  quotas: Quotas;
  caseBar: React.ReactNode;
}) {
  return (
    <header
      className="flex items-center gap-4 border-b px-4 py-2.5"
      style={{ background: "var(--panel-2)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{ background: "var(--violet)", boxShadow: "0 0 8px var(--violet)" }}
        />
        <span className="font-mono text-[13px] font-semibold tracking-wide">
          STEALTHGRAPH
        </span>
        <span className="text-[11px] text-[color:var(--muted-foreground)]">
          위협 행위자 지식그래프
        </span>
      </div>

      <div className="flex items-center gap-1 rounded p-0.5" style={{ background: "var(--muted)" }}>
        {(["demo", "live"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className="rounded px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: mode === m ? "var(--violet)" : "transparent",
              color: mode === m ? "var(--primary-foreground)" : "var(--muted-foreground)",
            }}
          >
            {m === "demo" ? "데모" : "실데이터"}
          </button>
        ))}
      </div>

      {mode === "demo" ? (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[color:var(--muted-foreground)]">시드</span>
          {seeds.map((s) => (
            <button
              key={s.id}
              title={s.hint}
              onClick={() => onSeed(s.id)}
              className="rounded px-2 py-1 font-mono text-[11px] transition-colors"
              style={{
                background: s.id === seed ? "var(--violet)" : "var(--muted)",
                color: s.id === seed ? "var(--primary-foreground)" : "var(--foreground)",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            value={liveSeedInput}
            onChange={(e) => onLiveSeedInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onLiveSeedSubmit()}
            placeholder="email:/domain:/ip:/url: 또는 값"
            disabled={!liveConfigured || liveBusy}
            className="rounded px-2 py-1 font-mono text-[11px] disabled:opacity-40"
            style={{ background: "var(--muted)", width: 220 }}
          />
          <button
            onClick={onLiveSeedSubmit}
            disabled={!liveConfigured || liveBusy || !liveSeedInput.trim()}
            className="rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40"
            style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
          >
            조사 시작
          </button>
          <button
            onClick={onLiveReset}
            disabled={liveBusy}
            className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
            style={{ background: "var(--muted)" }}
          >
            리셋
          </button>
          {quotas && <QuotaStrip quotas={quotas} />}
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        {caseBar}
        {loading && (
          <span className="text-[11px] text-[color:var(--muted-foreground)]">
            재계산 중…
          </span>
        )}
        {me === undefined ? null : me ? (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-[color:var(--muted-foreground)]">
              {me.display_name}
            </span>
            <a href={signOutHref()} className="underline-offset-2 hover:underline">
              로그아웃
            </a>
          </div>
        ) : (
          <a
            href={signInHref()}
            className="rounded px-2.5 py-1 text-[11px] font-medium"
            style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
          >
            coders.kr 로그인
          </a>
        )}
      </div>
    </header>
  );
}

function QuotaStrip({ quotas }: { quotas: NonNullable<Quotas> }) {
  return (
    <div className="flex items-center gap-1.5 pl-2 font-mono text-[10px] text-[color:var(--muted-foreground)]">
      {Object.entries(quotas).map(([code, q]) => (
        <Tip
          key={code}
          className="cursor-help border-b border-dotted border-[color:var(--border-strong)]"
          content={
            <>
              {smTipContent(code)}
              <div className="mt-1 font-mono" style={{ color: "var(--muted-foreground)" }}>
                사용량 {q.used.toLocaleString()} / {q.allowed.toLocaleString()}
              </div>
            </>
          }
        >
          {code} {q.used}/{q.allowed}
        </Tip>
      ))}
    </div>
  );
}

// ============================ LEFT TABS ============================

const LEFT_TAB_LABEL: Record<LeftTab, string> = {
  explore: "탐색 설정",
  quests: "임무",
  hypotheses: "가설",
};

function LeftTabs({
  mode,
  tab,
  onTab,
}: {
  mode: Mode;
  tab: LeftTab;
  onTab: (t: LeftTab) => void;
}) {
  // 임무(quests) tab is live-mode only
  const tabs: LeftTab[] =
    mode === "live"
      ? ["explore", "quests", "hypotheses"]
      : ["explore", "hypotheses"];
  return (
    <div className="flex border-b" style={{ background: "var(--panel-2)" }}>
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          className="flex-1 py-2 text-[12px] font-medium transition-colors"
          style={{
            color: tab === t ? "var(--foreground)" : "var(--muted-foreground)",
            borderBottom:
              tab === t ? "2px solid var(--violet)" : "2px solid transparent",
          }}
        >
          {LEFT_TAB_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

// ============================ EXPLORE PANEL ============================

type DemoAction = "overmerge" | "ablation" | "timesep" | "anchor" | "clear";

function applyDemo(
  action: DemoAction,
  ctx: {
    setTheta: (n: number) => void;
    setDisabled: (s: Set<string>) => void;
    setAsof: (n: number) => void;
    time: Meta["time"];
    setSelectedId: (s: string | null) => void;
  }
) {
  switch (action) {
    case "overmerge":
      ctx.setTheta(0.5);
      break;
    case "ablation":
      ctx.setDisabled(new Set(["stylometry", "timezone"]));
      break;
    case "timesep":
      ctx.setAsof(ctx.time.transfer + 86_400 * 60);
      ctx.setSelectedId("h_sable");
      break;
    case "anchor":
      ctx.setAsof(ctx.time.end);
      ctx.setSelectedId("h_kes2");
      break;
    case "clear":
      ctx.setTheta(0.75);
      ctx.setDisabled(new Set());
      ctx.setAsof(ctx.time.default);
      break;
  }
}

function ExplorePanel({
  mode,
  theta,
  onTheta,
  clusterCount,
  seedClusterSize,
  modules,
  disabled,
  weights,
  onToggleModule,
  onWeight,
  onReset,
  onDemo,
}: {
  mode: Mode;
  theta: number;
  onTheta: (n: number) => void;
  clusterCount: number;
  seedClusterSize: number;
  modules: ModuleInfo[];
  disabled: Set<string>;
  weights: Record<string, number>;
  onToggleModule: (k: string) => void;
  onWeight: (k: string, w: number) => void;
  onReset: () => void;
  onDemo: (a: DemoAction) => void;
}) {
  return (
    <div className="flex flex-col gap-5 p-3.5">
      {/* demo guide — the canned scenarios only make sense against the
          fixed demo corpus (fixed seeds, a fixed timeline); live mode has
          neither, so it doesn't get this section. */}
      {mode === "demo" && (
        <Section title="데모 시나리오" hint="4가지 핵심 동작">
          <div className="grid grid-cols-2 gap-1.5">
            <DemoBtn label="과병합 위험" onClick={() => onDemo("overmerge")} />
            <DemoBtn label="모듈 ablation" onClick={() => onDemo("ablation")} />
            <DemoBtn label="시간 분리" onClick={() => onDemo("timesep")} />
            <DemoBtn label="불변 앵커" onClick={() => onDemo("anchor")} />
          </div>
          <button
            onClick={() => onDemo("clear")}
            className="mt-1.5 w-full rounded py-1 text-[11px] text-[color:var(--muted-foreground)]"
            style={{ background: "var(--muted)" }}
          >
            설정 초기화
          </button>
        </Section>
      )}

      {/* theta */}
      <Section
        title="실체 임계값 θ"
        hint={`${clusterCount}개 클러스터 · 시드 실체 ${seedClusterSize}노드`}
      >
        <div className="flex items-center gap-2">
          <input
            type="range"
            className="sg-range flex-1"
            min={0.3}
            max={0.95}
            step={0.01}
            value={theta}
            onChange={(e) => onTheta(Number(e.target.value))}
          />
          <span className="w-10 text-right font-mono text-[12px]">
            {theta.toFixed(2)}
          </span>
        </div>
        <p className="mt-1 text-[10.5px] leading-snug text-[color:var(--muted-foreground)]">
          낮추면 약한 엣지까지 하나의 실체로 뭉침(과병합), 높이면 파편화.
        </p>
      </Section>

      {/* modules */}
      <Section title="증거 모듈" hint="토글 = ablation · 슬라이더 = 가중치">
        <div className="flex flex-col gap-2.5">
          {modules.map((m) => {
            const off = disabled.has(m.key);
            const w = weights[m.key] ?? m.weight;
            return (
              <div key={m.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onToggleModule(m.key)}
                    className="flex h-4 w-4 items-center justify-center rounded-sm border text-[9px]"
                    style={{
                      background: off ? "transparent" : "var(--violet)",
                      borderColor: off ? "var(--border-strong)" : "var(--violet)",
                      color: "var(--primary-foreground)",
                    }}
                    title={off ? "켜기" : "끄기"}
                  >
                    {off ? "" : "✓"}
                  </button>
                  <span
                    className="flex-1 text-[11.5px]"
                    style={{ opacity: off ? 0.4 : 1 }}
                    title={m.description}
                  >
                    {m.label}
                  </span>
                  <span
                    className="font-mono text-[10px] text-[color:var(--muted-foreground)]"
                    title={`위조가능성 ${m.forgeability}`}
                  >
                    f{m.forgeability.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-6" style={{ opacity: off ? 0.35 : 1 }}>
                  <input
                    type="range"
                    className="sg-range flex-1"
                    min={0}
                    max={1}
                    step={0.01}
                    value={w}
                    disabled={off}
                    onChange={(e) => onWeight(m.key, Number(e.target.value))}
                  />
                  <span className="w-8 text-right font-mono text-[10px]">
                    {w.toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <button
        onClick={onReset}
        className="rounded py-1.5 text-[11px]"
        style={{ background: "var(--muted)" }}
      >
        이 시드의 신뢰 초기화
      </button>
    </div>
  );
}

function DemoBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded px-2 py-1.5 text-left text-[11px] transition-colors"
      style={{ background: "var(--muted)" }}
    >
      {label}
    </button>
  );
}

function questProgress(quest: Quest, ctx: QuestCtx, active: boolean) {
  // Objectives only evaluate once the quest is active (its seed is loaded);
  // before that they read as pending so the briefing isn't spoiled.
  const done = quest.objectives.map((o) => (active ? o.done(ctx) : false));
  const doneCount = done.filter(Boolean).length;
  const total = quest.objectives.length;
  return { done, doneCount, total, complete: active && doneCount === total };
}

// ============================ QUEST PANEL (left "임무" tab) ============================

function QuestPanel({
  quests,
  activeQuestId,
  ctx,
  disabled,
  onStart,
  onStop,
  onReplay,
  replaying,
}: {
  quests: Quest[];
  activeQuestId: string | null;
  ctx: QuestCtx;
  disabled: boolean;
  onStart: (q: Quest) => void;
  onStop: () => void;
  onReplay: (q: Quest) => void;
  replaying: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <p className="text-[10.5px] leading-relaxed text-[color:var(--muted-foreground)]">
        직접 조사하려면 <b>조사 개시</b>, 분석관이 푸는 과정을 지켜보려면
        <b> 시뮬레이션 재생</b>을 누르세요. 재생은 녹화된 실제 수순대로
        그래프를 자동으로 움직입니다.
      </p>
      {quests.map((q) => {
        const active = activeQuestId === q.id;
        const { doneCount, total, complete } = questProgress(q, ctx, active);
        const accent = complete ? "var(--good)" : "var(--amber)";
        return (
          <div
            key={q.id}
            className="overflow-hidden rounded-md border"
            style={{
              background: "var(--panel-2)",
              borderTopColor: active ? accent : "var(--border)",
              borderRightColor: active ? accent : "var(--border)",
              borderBottomColor: active ? accent : "var(--border)",
              borderLeftColor: accent,
              borderLeftWidth: 3,
            }}
          >
            <div className="flex items-start gap-2 px-2.5 py-2">
              <span style={{ color: accent, fontSize: 13, lineHeight: 1.2 }}>⚑</span>
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[9px] uppercase tracking-wide" style={{ color: accent }}>
                  {q.tag}
                </span>
                <div className="mt-0.5 text-[13px] font-semibold">{q.title}</div>
                <div className="text-[10.5px] italic leading-snug text-[color:var(--muted-foreground)]">
                  {q.tagline}
                </div>
              </div>
              {active && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{ background: "var(--muted)", color: accent }}
                >
                  {doneCount}/{total}
                </span>
              )}
            </div>
            <div className="px-2.5 pb-2.5">
              <p className="mb-2.5 text-[10.5px] leading-relaxed text-[color:var(--muted-foreground)]">
                {q.briefing}
              </p>
              <div className="flex gap-1.5">
                <button
                  onClick={() => onStart(q)}
                  disabled={disabled || replaying}
                  className="flex-1 rounded py-1.5 text-[11px] font-semibold disabled:opacity-40"
                  style={{ background: accent, color: "#0a0c12" }}
                >
                  {active ? "↻ 처음부터 다시" : "조사 개시"}
                </button>
                {active && (
                  <button
                    onClick={onStop}
                    className="rounded px-2 py-1.5 text-[11px]"
                    style={{ background: "var(--muted)" }}
                    title="추적 중단 (그래프·신뢰는 유지)"
                  >
                    중단
                  </button>
                )}
              </div>
              {REPLAYS[q.id] && (
                <button
                  onClick={() => onReplay(q)}
                  disabled={disabled || replaying}
                  className="mt-1.5 w-full rounded py-1.5 text-[11px] font-medium disabled:opacity-40"
                  style={{ background: "var(--muted)", color: "var(--violet)", border: "1px solid var(--border-strong)" }}
                  title="분석관의 실제 조사 수순을 자동 재생"
                >
                  ▶ 시뮬레이션 재생
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ QUEST TRACKER (floating HUD on the graph, top-right) ============

// Floating narration bar shown while a recorded investigation replays.
function ReplayBar({
  replay,
  onStop,
}: {
  replay: { step: number; total: number; move: string; narrate: string };
  onStop: () => void;
}) {
  return (
    <div
      className="absolute bottom-3 left-1/2 w-[min(560px,calc(100%-24px))] -translate-x-1/2 overflow-hidden rounded-lg border shadow-lg"
      style={{ background: "rgba(14,17,26,0.92)", backdropFilter: "blur(8px)", borderColor: "var(--violet)" }}
    >
      <div className="h-1 w-full" style={{ background: "var(--muted)" }}>
        <div
          className="h-full transition-all"
          style={{ width: `${((replay.step + 1) / replay.total) * 100}%`, background: "var(--violet)" }}
        />
      </div>
      <div className="flex items-start gap-3 px-3.5 py-2.5">
        <span
          className="mt-0.5 shrink-0 animate-pulse"
          style={{ color: "var(--violet)", fontSize: 12 }}
        >
          ▶
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px]" style={{ color: "var(--violet)" }}>
              시뮬레이션 {replay.step + 1}/{replay.total}
            </span>
            <span className="text-[12px] font-semibold">{replay.move}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--muted-foreground)]">
            {replay.narrate}
          </p>
        </div>
        <button
          onClick={onStop}
          className="shrink-0 rounded px-2 py-1 text-[11px]"
          style={{ background: "var(--muted)" }}
          title="재생 중단"
        >
          정지
        </button>
      </div>
    </div>
  );
}

function QuestTracker({
  quest,
  ctx,
  onClose,
}: {
  quest: Quest;
  ctx: QuestCtx;
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { done, doneCount, total, complete } = questProgress(quest, ctx, true);
  const accent = complete ? "var(--good)" : "var(--amber)";

  return (
    <div
      className="absolute right-3 top-3 w-[262px] overflow-hidden rounded-md border shadow-lg"
      style={{
        background: "rgba(14,17,26,0.86)",
        backdropFilter: "blur(6px)",
        borderColor: accent,
        borderLeftWidth: 3,
        borderLeftColor: accent,
      }}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span style={{ color: accent, fontSize: 12 }}>⚑</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold">{quest.title}</div>
        </div>
        <span className="shrink-0 font-mono text-[10px]" style={{ color: accent }}>
          {doneCount}/{total}
        </span>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="shrink-0 text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
          title={collapsed ? "펼치기" : "접기"}
        >
          {collapsed ? "▾" : "▴"}
        </button>
        <button
          onClick={onClose}
          className="shrink-0 text-[color:var(--muted-foreground)] hover:text-[color:var(--danger)]"
          title="추적 닫기"
        >
          ✕
        </button>
      </div>

      {/* progress bar */}
      <div className="h-1 w-full" style={{ background: "var(--muted)" }}>
        <div
          className="h-full transition-all"
          style={{ width: `${(doneCount / total) * 100}%`, background: accent }}
        />
      </div>

      {!collapsed && (
        <div className="px-2.5 py-2">
          <ul className="flex flex-col gap-1">
            {quest.objectives.map((o, i) => (
              <li key={o.id} className="flex items-start gap-1.5 text-[11px]">
                <span
                  className="mt-[1px] shrink-0 font-mono"
                  style={{ color: done[i] ? "var(--good)" : "var(--muted-foreground)" }}
                >
                  {done[i] ? "✓" : "○"}
                </span>
                <span
                  style={{
                    color: done[i] ? "var(--muted-foreground)" : "var(--foreground)",
                    textDecoration: done[i] ? "line-through" : "none",
                  }}
                >
                  {o.label}
                </span>
              </li>
            ))}
          </ul>
          {complete && (
            <div
              className="mt-2 rounded border px-2 py-1.5 text-[10px] leading-relaxed"
              style={{ borderColor: "var(--good)", color: "var(--good)" }}
            >
              ✔ 사건 종결 — {quest.resolved}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
          {title}
        </h3>
        {hint && (
          <span className="text-[10px] text-[color:var(--muted-foreground)]">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ============================ HYPOTHESIS PANEL ============================

function HypothesisPanel({
  blob,
  nodes,
  onAdd,
  onDelete,
  onToggleActive,
}: {
  blob: BeliefBlob;
  nodes: GraphResponse["nodes"];
  onAdd: () => void;
  onDelete: (id: string) => void;
  onToggleActive: (id: string) => void;
}) {
  const byId = useMemo(() => {
    const m = new Map(nodes.map((n) => [n.id, n]));
    return m;
  }, [nodes]);

  return (
    <div className="flex flex-col gap-3 p-3.5">
      <button
        onClick={onAdd}
        className="rounded py-1.5 text-[12px] font-medium"
        style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
      >
        + 가설 추가 (경쟁 가설 = ACH)
      </button>
      {blob.categories.length === 0 && (
        <p className="text-[11px] leading-relaxed text-[color:var(--muted-foreground)]">
          아직 가설이 없습니다. 가설을 추가하고 노드를 신뢰하면 그 가설의
          수집 정보가 여기 도시에로 쌓입니다.
        </p>
      )}
      {blob.categories.map((cat) => {
        const trusted = blob.trustByCat[cat.id] ?? [];
        const active = blob.activeCats.includes(cat.id);
        const nodesOf = trusted
          .map((id) => byId.get(id))
          .filter(Boolean) as GraphResponse["nodes"];
        const byType = new Map<NodeType, GraphResponse["nodes"]>();
        const sources = new Map<string, number>();
        for (const n of nodesOf) {
          if (!byType.has(n.type)) byType.set(n.type, []);
          byType.get(n.type)!.push(n);
          for (const s of n.sources)
            sources.set(s, (sources.get(s) ?? 0) + 1);
        }
        return (
          <div
            key={cat.id}
            className="rounded-md border p-2.5"
            style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
          >
            <div className="flex items-center gap-2">
              <button
                onClick={() => onToggleActive(cat.id)}
                className="flex h-4 w-4 items-center justify-center rounded-sm border text-[9px]"
                style={{
                  background: active ? cat.color : "transparent",
                  borderColor: active ? cat.color : "var(--border-strong)",
                  color: "#0a0c12",
                }}
                title={active ? "숨기기" : "표시"}
              >
                {active ? "✓" : ""}
              </button>
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: cat.color }}
              />
              <span className="flex-1 text-[12px] font-medium">{cat.label}</span>
              <span className="font-mono text-[10px] text-[color:var(--muted-foreground)]">
                {trusted.length}
              </span>
              <button
                onClick={() => onDelete(cat.id)}
                className="text-[11px] text-[color:var(--muted-foreground)] hover:text-[color:var(--danger)]"
                title="가설 삭제"
              >
                ✕
              </button>
            </div>

            {nodesOf.length > 0 && (
              <div className="mt-2.5 flex flex-col gap-2">
                {/* identifiers by type */}
                {[...byType.entries()].map(([type, list]) => (
                  <div key={type} className="flex flex-col gap-1">
                    <div className="text-[10px] uppercase tracking-wide text-[color:var(--muted-foreground)]">
                      {TYPE_LABEL[type]} · {list.length}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {list.map((n) => (
                        <span
                          key={n.id}
                          className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                          style={{
                            background: "var(--muted)",
                            color: PALETTE[type],
                          }}
                        >
                          {n.label}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {/* source aggregation */}
                <div className="mt-1 border-t pt-1.5">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-[color:var(--muted-foreground)]">
                    출처 집계
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[...sources.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .map(([s, c]) => (
                        <span
                          key={s}
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{ background: "var(--muted)" }}
                        >
                          {s} <span className="opacity-60">×{c}</span>
                        </span>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================ TIMELINE ============================

function Timeline({
  time,
  asof,
  onAsof,
}: {
  time: Meta["time"];
  asof: number;
  onAsof: (n: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const span = time.end - time.start;
  const frac = (asof - time.start) / span;
  const transferFrac = (time.transfer - time.start) / span;

  const setFromClientX = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onAsof(Math.round(time.start + f * span));
  };

  const onDown = (e: React.PointerEvent) => {
    setFromClientX(e.clientX);
    const move = (ev: PointerEvent) => setFromClientX(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const afterTransfer = asof >= time.transfer;

  return (
    <div
      className="border-t px-4 py-2.5"
      style={{ background: "var(--panel-2)" }}
    >
      <div className="mb-1.5 flex items-center justify-between text-[10.5px]">
        <span className="font-mono text-[color:var(--muted-foreground)]">
          {fmtDate(time.start)}
        </span>
        <span className="flex items-center gap-2 font-mono">
          <span
            className="rounded px-1.5 py-0.5"
            style={{
              background: afterTransfer ? "var(--danger-soft)" : "var(--muted)",
            }}
          >
            {fmtDate(asof)}
          </span>
          {afterTransfer && (
            <span className="text-[10px]" style={{ color: "var(--danger)" }}>
              양도 지점 이후 — sable_kite 분리
            </span>
          )}
        </span>
        <span className="font-mono text-[color:var(--muted-foreground)]">
          {fmtDate(time.end)}
        </span>
      </div>
      <div
        ref={barRef}
        onPointerDown={onDown}
        className="relative h-6 cursor-pointer select-none"
      >
        {/* track */}
        <div
          className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full"
          style={{ background: "var(--muted)" }}
        />
        {/* filled */}
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{ width: `${frac * 100}%`, background: "var(--violet)" }}
        />
        {/* transfer marker */}
        <div
          className="absolute -translate-x-1/2"
          style={{ left: `${transferFrac * 100}%`, top: -2 }}
          title={`계정 양도: ${fmtDate(time.transfer)}`}
        >
          <div style={{ color: "var(--amber)", fontSize: 10, lineHeight: 1 }}>▼</div>
        </div>
        {/* handle */}
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${frac * 100}%`,
            background: "var(--violet)",
            border: "2px solid var(--background)",
            boxShadow: "0 0 0 1px var(--violet)",
          }}
        />
      </div>
    </div>
  );
}

// ============================ LIVE QUERY (Inspector) ============================

type LiveInspectorProps = {
  queryable: { type: string; value: string; modules: { id: string; code: string; label: string }[] } | null | undefined;
  onFire: (moduleId: string, nodeId: string) => void;
  onCompare: (a: string, b: string) => void;
  busy: boolean;
  configured: boolean;
  lastFire: FireLogEntry | null;
  error: string | null;
};

function LiveQuerySection({ live, nodeId }: { live: LiveInspectorProps; nodeId: string }) {
  if (!live.configured) {
    return (
      <div
        className="rounded-md border p-2.5 text-[11px] leading-relaxed"
        style={{ background: "var(--panel-2)", color: "var(--muted-foreground)" }}
      >
        StealthMole API 키가 설정되지 않았습니다. 백엔드에 <code>STEALTHMOLE_ACCESS_KEY</code>/
        <code>STEALTHMOLE_SECRET_KEY</code>를 설정하면 실데이터 질의가 활성화됩니다.
      </div>
    );
  }
  const modules = live.queryable?.modules ?? [];
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
        StealthMole 질의 — 클릭 1회 = 실제 API 호출 1회
      </h4>
      {modules.length === 0 ? (
        <p className="text-[11px] text-[color:var(--muted-foreground)]">
          이 식별자에 대해 아직 질의 가능한 모듈이 없거나 모두 조회 완료했습니다.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {modules.map((m) => (
            <Tip key={m.id} content={smTipContent(m.code)}>
              <button
                disabled={live.busy}
                onClick={() => live.onFire(m.id, nodeId)}
                className="rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40"
                style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
              >
                {m.code} 질의
              </button>
            </Tip>
          ))}
        </div>
      )}
      {live.lastFire && (
        <p
          className="mt-2 text-[10.5px] leading-relaxed"
          style={{
            color:
              live.lastFire.kind === "error" || live.lastFire.kind === "quota" || live.lastFire.kind === "ratelimited"
                ? "var(--danger)"
                : "var(--muted-foreground)",
          }}
        >
          {live.lastFire.module ? `[${live.lastFire.module}] ` : ""}
          {live.lastFire.note}
        </p>
      )}
      {live.error && (
        <p className="mt-2 text-[10.5px]" style={{ color: "var(--danger)" }}>
          {live.error}
        </p>
      )}
    </div>
  );
}

// ============================ INSPECTOR ============================

function Inspector({
  selected,
  view,
  edges,
  nodes,
  roots,
  blob,
  asof,
  transfer,
  onToggleTrust,
  live,
}: {
  selected: GraphResponse["nodes"][number] | null;
  view: NodeView | null;
  edges: GraphEdge[];
  nodes: GraphResponse["nodes"];
  roots: Set<string>;
  blob: BeliefBlob;
  asof: number | null;
  transfer: number | null;
  onToggleTrust: (nodeId: string, catId?: string) => void;
  live: LiveInspectorProps | null;
}) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  if (!selected) {
    return (
      <div className="p-4">
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
          인스펙터
        </h3>
        <p className="text-[11.5px] leading-relaxed text-[color:var(--muted-foreground)]">
          노드를 클릭하면 근거와 신뢰 판단을 볼 수 있습니다. 노드를 신뢰하면
          정체성(identity)이 넓어지고 다음 후보(프론티어)가 밝아집니다.
        </p>
        <div className="mt-4 flex flex-col gap-1.5">
          <LegendRow color="var(--violet)" label="active 엣지 (P ≥ θ)" />
          <LegendRow color="var(--danger)" label="contested (반증으로 하락)" />
          <LegendRow color="var(--good)" label="신뢰됨 (✓ 링)" />
          <LegendRow color="var(--muted-foreground)" label="약한/끊긴 엣지" />
        </div>
      </div>
    );
  }

  // edges incident to the selected node
  const incident = edges
    .filter((e) => e.a === selected.id || e.b === selected.id)
    .map((e) => {
      const other = e.a === selected.id ? e.b : e.a;
      return { edge: e, other, isRoot: roots.has(other) };
    })
    .sort((a, b) => {
      if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
      return b.edge.p - a.edge.p;
    });

  const toIdentity = incident.filter((x) => x.isRoot);
  const others = incident.filter((x) => !x.isRoot);

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* header */}
      <div>
        <div className="flex items-center gap-2">
          <span
            className="h-3 w-3 rounded-full"
            style={{ background: PALETTE[selected.type] }}
          />
          <span className="font-mono text-[14px] font-semibold">
            {selected.label}
          </span>
          {selected.anchor && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
              style={{ background: "var(--muted)", color: "var(--violet)" }}
            >
              불변 앵커
            </span>
          )}
          <BreadthBadge node={selected} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[color:var(--muted-foreground)]">
          <span>{TYPE_LABEL[selected.type]}</span>
          {view && (
            <>
              <span>·</span>
              <span>{tierLabel(view.tier)}</span>
              <span>·</span>
              <span>hop {view.hop === Infinity ? "∞" : view.hop}</span>
              <span>·</span>
              <span>밝기 {(view.brightness * 100).toFixed(0)}%</span>
            </>
          )}
        </div>
      </div>

      {/* meta + sources */}
      {(Object.keys(selected.meta).length > 0 || selected.sources.length > 0) && (
        <div
          className="rounded-md border p-2.5 text-[11px]"
          style={{ background: "var(--panel-2)" }}
        >
          {Object.entries(selected.meta).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-0.5">
              <span className="text-[color:var(--muted-foreground)]">{k}</span>
              <span className="text-right font-mono">{v}</span>
            </div>
          ))}
          {selected.sources.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1 border-t pt-1.5">
              {selected.sources.map((s) => (
                <span
                  key={s}
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{ background: "var(--muted)" }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* live: StealthMole query — the only place a real API call fires */}
      {live && (
        <LiveQuerySection live={live} nodeId={selected.id} />
      )}

      {/* category trust checkboxes */}
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
          신뢰 귀속 <kbd className="sg-kbd ml-1">Space</kbd>
        </h4>
        {blob.categories.length === 0 ? (
          <button
            onClick={() => onToggleTrust(selected.id)}
            className="w-full rounded py-1.5 text-[11px] font-medium"
            style={{ background: "var(--violet)", color: "var(--primary-foreground)" }}
          >
            신뢰 (가설 자동 생성)
          </button>
        ) : (
          <div className="flex flex-col gap-1">
            {blob.categories.map((cat) => {
              const on = (blob.trustByCat[cat.id] ?? []).includes(selected.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => onToggleTrust(selected.id, cat.id)}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px]"
                  style={{ background: "var(--muted)" }}
                >
                  <span
                    className="flex h-4 w-4 items-center justify-center rounded-sm border text-[9px]"
                    style={{
                      background: on ? cat.color : "transparent",
                      borderColor: on ? cat.color : "var(--border-strong)",
                      color: "#0a0c12",
                    }}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: cat.color }}
                  />
                  {cat.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* why trusted — connections to identity */}
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
          이 노드가 신뢰된 이유
        </h4>
        {toIdentity.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-[color:var(--muted-foreground)]">
            현재 시점에 identity(시드+신뢰 노드)와의 직접 연결이 없습니다.
            아래 후보 연결을 확인하세요.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {toIdentity.map(({ edge, other }) => (
              <EdgeAccordion
                key={other}
                edge={edge}
                otherLabel={byId.get(other)?.label ?? other}
                defaultOpen
                busy={live?.busy}
                onCompare={
                  live && !!selected.meta.ref && !!byId.get(other)?.meta.ref
                    ? () => live.onCompare(selected.id, other)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* other candidates */}
      {others.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] text-[color:var(--muted-foreground)]">
            다른 후보 {others.length}개 보기
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {others.map(({ edge, other }) => (
              <EdgeAccordion
                key={other}
                edge={edge}
                otherLabel={byId.get(other)?.label ?? other}
                busy={live?.busy}
                onCompare={
                  live && !!selected.meta.ref && !!byId.get(other)?.meta.ref
                    ? () => live.onCompare(selected.id, other)
                    : undefined
                }
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// Node badge: once an identifier's reuse-breadth is known (CB/CDS queried),
// classify it as a rare "고유 신원" (strong anchor) or "거래 재고" (a widely-
// traded credential — a weak anchor whose shared edges get discounted).
function BreadthBadge({ node }: { node: GraphNode }) {
  const rf = node.reuse_factor;
  const b = node.breadth ?? {};
  if (rf == null || Object.keys(b).length === 0) return null;
  const traded = rf < 0.6;
  const detail =
    b.cb != null ? ` CB=${b.cb}` : b.cds != null ? ` CDS=${b.cds}` : "";
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
      style={{
        background: "var(--muted)",
        color: traded ? "var(--amber)" : "var(--good)",
      }}
      title={`재사용 희소도 ${(rf * 100).toFixed(0)}% — ${traded ? "널리 거래되는 크리덴셜, 약한 앵커" : "드문 식별자, 강한 앵커"}`}
    >
      {traded ? "거래 재고" : "고유 신원"}
      {detail}
    </span>
  );
}

// Per-edge merge/don't-merge guidance driven by the reuse-breadth discount.
// The connection exists because the two nodes share an identifier; if that
// identifier turns out to be a widely-traded credential, two DIFFERENT
// people could each hold it, so the shared-identifier link is weak evidence
// of "same entity" — we keep only `rarity` of the original strength.
function RarityVerdict({ edge }: { edge: GraphEdge }) {
  const r = edge.rarity;
  if (r == null || r >= 0.85) return null; // full-strength link — no caveat
  const pct = Math.round(r * 100);
  const strong = r < 0.4;
  return (
    <div
      className="mb-1.5 rounded px-2 py-1 text-[10px] leading-relaxed"
      style={{ background: "rgba(245,185,66,0.1)", color: "var(--amber)" }}
    >
      {strong
        ? `⚠ 이 연결의 근거인 공유 식별자가 여러 콤보리스트에 유통되는 흔한 크리덴셜입니다. 서로 다른 사람이 우연히 같이 가졌을 수 있어 '동일 실체' 증거로는 약함 — 증거를 ${pct}%만 반영(나머지 중립화)했습니다.`
        : `⚠ 이 연결의 근거인 공유 식별자가 다소 흔합니다 (다른 곳에도 유통). 증거를 ${pct}%만 반영해 소폭 할인했습니다.`}
    </div>
  );
}

function EdgeAccordion({
  edge,
  otherLabel,
  defaultOpen = false,
  onCompare,
  busy = false,
}: {
  edge: GraphEdge;
  otherLabel: string;
  defaultOpen?: boolean;
  onCompare?: () => void;
  busy?: boolean;
}) {
  const active = edge.contributions.filter((c) => c.active);
  const pColor = edge.contested
    ? "var(--danger)"
    : edge.p >= 0.75
      ? "var(--violet)"
      : "var(--muted-foreground)";
  return (
    <details open={defaultOpen} className="rounded-md border" style={{ background: "var(--panel-2)" }}>
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
        <span className="flex-1 font-mono text-[11.5px]">↔ {otherLabel}</span>
        {edge.contested && (
          <span
            className="rounded px-1 py-0.5 text-[9px] font-semibold"
            style={{ background: "var(--danger-soft)", color: "#fff" }}
          >
            반증
          </span>
        )}
        {edge.discounted && !edge.contested && (
          <span
            className="rounded px-1 py-0.5 text-[9px] font-semibold"
            style={{ background: "rgba(245,185,66,0.25)", color: "var(--amber)" }}
          >
            재고성
          </span>
        )}
        <span className="font-mono text-[12px] font-semibold" style={{ color: pColor }}>
          {(edge.p * 100).toFixed(0)}%
        </span>
      </summary>
      <div className="border-t px-2.5 py-2">
        <RarityVerdict edge={edge} />
        {active.length === 0 ? (
          <p className="text-[10.5px] text-[color:var(--muted-foreground)]">
            현재 시점에 유효한 증거 없음 (끊긴 링크).
          </p>
        ) : (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[color:var(--muted-foreground)]">
                <th className="text-left font-medium">모듈</th>
                <th className="text-right font-medium">raw</th>
                <th className="text-right font-medium">eff.w</th>
                <th className="text-right font-medium">기여</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {active.map((c, i) => (
                <tr key={i} title={`${c.source} · forge ${c.forgeability}${c.note ? " · " + c.note : ""}`}>
                  <td
                    className="py-0.5"
                    style={{ color: c.raw < 0.5 ? "var(--danger)" : "var(--foreground)" }}
                  >
                    {c.label}
                  </td>
                  <td className="text-right">{c.raw.toFixed(2)}</td>
                  <td className="text-right">{c.eff_weight.toFixed(2)}</td>
                  <td
                    className="text-right"
                    style={{ color: c.contrib >= 0 ? "var(--good)" : "var(--danger)" }}
                  >
                    {c.contrib >= 0 ? "+" : ""}
                    {c.contrib.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {active.some((c) => c.source) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[...new Set(active.map((c) => c.source))].map((s) => (
              <span
                key={s}
                className="rounded px-1 py-0.5 text-[9px]"
                style={{ background: "var(--muted)" }}
              >
                {s}
              </span>
            ))}
          </div>
        )}
        {onCompare && (
          <button
            onClick={onCompare}
            disabled={busy}
            className="mt-2 w-full rounded py-1 text-[10.5px] font-medium disabled:opacity-50"
            style={{ background: "var(--muted)", color: "var(--foreground)" }}
            title="두 계정의 메시지 문체를 비교해 동일/다른 주체를 판정 (StealthMole /tt/node 조회)"
          >
            🔬 문체 비교 (반증 검증)
          </button>
        )}
      </div>
    </details>
  );
}

// ============================ misc ============================

/**
 * Hover tooltip that escapes scrollable/overflow-hidden containers by
 * portaling a position:fixed box to <body>, anchored to the trigger's
 * bounding rect. The portal only mounts after a (client-only) mouseenter,
 * so it's safe under static export / SSR — `document` is never touched
 * during prerender.
 */
function Tip({
  content,
  children,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(r.left + r.width / 2, 130), window.innerWidth - 130);
    setBox({ left, top: r.bottom + 6 });
  };
  return (
    <span
      ref={ref}
      className={className}
      onMouseEnter={show}
      onMouseLeave={() => setBox(null)}
    >
      {children}
      {box &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[100] max-w-[250px] -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-[10.5px] leading-snug shadow-lg"
            style={{
              left: box.left,
              top: box.top,
              background: "var(--panel-2)",
              borderColor: "var(--border-strong)",
              color: "var(--foreground)",
            }}
          >
            {content}
          </div>,
          document.body
        )}
    </span>
  );
}

/** Tooltip body for a StealthMole module code (풀네임 + 한 줄 설명). */
function smTipContent(code: string): React.ReactNode {
  const info = SM_MODULE_INFO[code];
  if (!info) return code;
  return (
    <>
      <div className="font-semibold">
        {code} · {info.name}
      </div>
      <div className="mt-0.5" style={{ color: "var(--muted-foreground)" }}>
        {info.desc}
      </div>
    </>
  );
}

function Resizer({
  onPointerDown,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="w-1 shrink-0 cursor-col-resize transition-colors hover:bg-[color:var(--violet)]"
      style={{ background: "var(--border)" }}
      title="드래그로 패널 너비 조절"
    />
  );
}

function tierLabel(t: NodeView["tier"]): string {
  return { trusted: "신뢰됨", frontier: "프론티어", preview: "프리뷰", hidden: "숨김" }[t];
}

function Legend() {
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-md border p-2 text-[10px]"
      style={{ background: "rgba(14,17,26,0.8)", backdropFilter: "blur(4px)" }}
    >
      <div className="mb-0.5 font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
        식별자 유형
      </div>
      {(Object.keys(PALETTE) as NodeType[]).map((t) => (
        <div key={t} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: PALETTE[t] }}
          />
          <span>{TYPE_LABEL[t]}</span>
        </div>
      ))}
    </div>
  );
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span className="text-[color:var(--muted-foreground)]">{label}</span>
    </div>
  );
}
