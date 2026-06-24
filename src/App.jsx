import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, Cell, ReferenceLine, Legend,
} from "recharts";
import { dbLoadAll, dbSaveDataset, dbDeleteDataset } from "./supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const TP_MULT = 1.04825;
const SL_MULT = 0.94725;

const TF_ORDER = ["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M","main"];
const tfSort   = (a, b) => {
  const ia = TF_ORDER.indexOf(a), ib = TF_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
};

const SL_FILTER_THRESHOLD = 0.6;

const SL_BUCKETS = [
  { label: "0-0.5",  min: 0,   max: 0.5 },
  { label: "0.5-1",  min: 0.5, max: 1.0 },
  { label: "1-1.5",  min: 1.0, max: 1.5 },
  { label: "1.5-2",  min: 1.5, max: 2.0 },
  { label: "2-2.5",  min: 2.0, max: 2.5 },
  { label: "2.5-3",  min: 2.5, max: 3.0 },
  { label: "+3",     min: 3.0, max: Infinity },
];

const TABS = [
  { id: "overview",     label: "Genel Bakis"       },
  { id: "winrate",      label: "Win Rate"           },
  { id: "monthly",      label: "Aylik Sonuclar"     },
  { id: "equity",       label: "Equity Curve"       },
  { id: "distribution", label: "Islem % Dagilimi"   },
  { id: "streaks",      label: "Seriler"            },
  { id: "conflict",     label: "Conflict Type"      },
];

const C = {
  green:"#00e5a0", red:"#ff4757", orange:"#ff8c42", blue:"#4da6ff",
  muted:"#4a5a6a", bg:"#070c11", surface:"#0c1520", surface2:"#111d2b",
  border:"rgba(255,255,255,0.07)", text:"#b0c4d8", textBright:"#e4eef8",
};

// ─────────────────────────────────────────────────────────────────────────────
//  FILENAME PARSER
// ─────────────────────────────────────────────────────────────────────────────
const TICKER_MAP = {
  btc:"BTCUSDT", eth:"ETHUSDT", bnb:"BNBUSDT", sol:"SOLUSDT",
  xrp:"XRPUSDT", ada:"ADAUSDT", doge:"DOGEUSDT", dot:"DOTUSDT",
  avax:"AVAXUSDT", matic:"MATICUSDT", link:"LINKUSDT", uni:"UNIUSDT",
  atom:"ATOMUSDT", ltc:"LTCUSDT", etc:"ETCUSDT", xlm:"XLMUSDT",
  algo:"ALGOUSDT", vet:"VETUSDT", icp:"ICPUSDT", fil:"FILUSDT",
  aave:"AAVEUSDT", mkr:"MKRUSDT", comp:"COMPUSDT", snx:"SNXUSDT",
  crv:"CRVUSDT", sushi:"SUSHIUSDT", yfi:"YFIUSDT", uma:"UMAUSDT",
  trx:"TRXUSDT", near:"NEARUSDT", ftm:"FTMUSDT", one:"ONEUSDT",
  hbar:"HBARUSDT", egld:"EGLDUSDT", theta:"THETAUSDT", axs:"AXSUSDT",
  sand:"SANDUSDT", mana:"MANAUSDT", enj:"ENJUSDT", chz:"CHZUSDT",
  gala:"GALAUSDT", flow:"FLOWUSDT", ape:"APEUSDT", ldo:"LDOUSDT",
  op:"OPUSDT", arb:"ARBUSDT", sui:"SUIUSDT", apt:"APTUSDT",
  sei:"SEIUSDT", tia:"TIAUSDT", inj:"INJUSDT", blur:"BLURUSDT",
  pepe:"PEPEUSDT", wif:"WIFUSDT", bonk:"BONKUSDT",
};

const PAIR_PART_RX = /^[A-Z][A-Z0-9.]{2,}$/;

function normalizePair(raw) {
  const upper = raw.toUpperCase();
  if (PAIR_PART_RX.test(upper)) return { pair: upper, contractType: "P" };
  const lower = raw.toLowerCase();
  if (TICKER_MAP[lower]) return { pair: TICKER_MAP[lower], contractType: "P" };
  if (upper.endsWith("USDT")) return { pair: upper, contractType: "P" };
  return { pair: upper + "USDT", contractType: "P" };
}

function findPairPart(parts, startIdx, dateRx) {
  for (let i = startIdx; i < parts.length; i++) {
    const part = parts[i];
    if (dateRx.test(part)) break;
    if (PAIR_PART_RX.test(part)) return { rawPair: part, pairIdx: i };
  }
  return { rawPair: parts[startIdx] || "UNKNOWN", pairIdx: startIdx };
}

function normalizeTimeframe(tf) {
  if (!tf || tf === "main") return tf || "main";
  return tf === "1M" ? "1M" : tf.toLowerCase();
}

function inferExchangeFromFilename(name) {
  const lower = (name || "").toLowerCase();
  if (lower.includes("mexc")) return "MEXC";
  if (lower.includes("ibkr")) return "IBKR";
  if (lower.includes("binance")) return "BINANCE";
  if (lower.includes("bybit")) return "BYBIT";
  if (lower.includes("okx")) return "OKX";
  if (lower.includes("kucoin")) return "KUCOIN";
  if (lower.includes("coinbase")) return "COINBASE";
  if (lower.includes("gate")) return "GATE";
  return "";
}

function coinSymbol(pair) {
  if (!pair) return "?";
  return pair.replace(/\..*$/, "").replace(/USDT$/i, "").toUpperCase();
}

const TF_RX = /^(\d+)(m|h|d|w|M)$/i;

function parseFilename(name) {
  const base   = name.replace(/\.(csv|CSV)$/, "");
  const parts  = base.split("_");
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;

  let pair = "UNKNOWN", contractType = "P", startDate = "", endDate = "", timeframe = "main";

  const tradeIdx = parts.indexOf("trades");
  if (tradeIdx >= 0) {
    const { rawPair, pairIdx } = findPairPart(parts, tradeIdx + 1, dateRx);
    const nextPart = parts[pairIdx + 1] || "";
    const rawContract = /^[A-Z]$/.test(nextPart) && !dateRx.test(nextPart) ? nextPart : "";
    const normalized  = normalizePair(rawPair);
    pair         = normalized.pair;
    contractType = rawContract.toUpperCase() || normalized.contractType;
    const dateIdxs = parts.map((p, i) => (dateRx.test(p) ? i : -1)).filter((i) => i >= 0);
    if (dateIdxs.length >= 2) {
      startDate = parts[dateIdxs[0]];
      endDate   = parts[dateIdxs[1]];
      const after = dateIdxs[dateIdxs.length - 1] + 1;
      if (after < parts.length) timeframe = normalizeTimeframe(parts[after]);
    }
  } else if (parts.length >= 2 && TF_RX.test(parts[parts.length - 1])) {
    timeframe = normalizeTimeframe(parts[parts.length - 1]);
    const normalized = normalizePair(parts.slice(0, parts.length - 1).join("_"));
    pair         = normalized.pair;
    contractType = normalized.contractType;
  } else if (parts.length === 1) {
    const normalized = normalizePair(parts[0]);
    pair = normalized.pair;
    contractType = normalized.contractType;
  }

  timeframe = normalizeTimeframe(timeframe);
  const storageKey = [pair, timeframe, startDate, endDate].filter(Boolean).join("__");
  return { pair, contractType, startDate, endDate, timeframe, storageKey };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSV PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(text, filename, exchange = "") {
  const lines   = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  const trades  = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const r    = {};
    headers.forEach((h, i) => { r[h] = (vals[i] ?? "").trim(); });
    const entryPrice = parseFloat(r["entry_price"]) || 0;
    const slPrice    = parseFloat(r["sl_price"])    || 0;
    const slFromCsv  = parseFloat(r["entry_sl_pct"]) || 0;
    const slPct      = slFromCsv > 0
      ? slFromCsv
      : entryPrice
        ? +((Math.abs(slPrice - entryPrice) / entryPrice) * 100).toFixed(4)
        : 0;
    return {
      entryTime:    r["entry_time"]           || "",
      direction:    (r["direction"]           || "").toUpperCase(),
      entryPrice,
      tpPrice:      parseFloat(r["tp_price"])      || 0,
      slPrice,
      slPct,
      result:       (r["result"]             || "").toUpperCase(),
      exitTime:     r["exit_time"]           || "",
      conflictType: (r["conflict_type"]      || "none").toLowerCase(),
      month:        r["month"]               || "",
      monthWR:      r["month_win_rate"]      || "",
      overallWR:    r["overall_win_rate_pct"]|| "",
    };
  });
  const meta = parseFilename(filename);
  meta.exchange = exchange || inferExchangeFromFilename(filename) || "UNKNOWN";
  return { meta, trades, filename, uploadedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────
const validTrades = (trades) => trades.filter((t) => t.result !== "CONFLICT");

function tradeSlPct(t) {
  if (t.slPct > 0) return t.slPct;
  if (!t.entryPrice) return 0;
  return (Math.abs(t.slPrice - t.entryPrice) / t.entryPrice) * 100;
}

const CSV_EXPORT_HEADERS = [
  "entry_time", "direction", "entry_price", "tp_price", "sl_price", "entry_sl_pct",
  "result", "exit_time", "conflict_type", "month", "month_win_rate", "overall_win_rate_pct",
];

function csvCell(val) {
  const s = val == null ? "" : String(val);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tradesToCSV(trades) {
  const rows = [CSV_EXPORT_HEADERS.join(",")];
  (trades || []).forEach((t) => {
    const slPct = tradeSlPct(t);
    rows.push([
      t.entryTime,
      t.direction,
      t.entryPrice || "",
      t.tpPrice || "",
      t.slPrice || "",
      slPct ? +slPct.toFixed(4) : "",
      t.result,
      t.exitTime,
      t.conflictType || "none",
      t.month,
      t.monthWR,
      t.overallWR,
    ].map(csvCell).join(","));
  });
  return rows.join("\n");
}

function buildExportFilename(dataset) {
  if (dataset.filename) return dataset.filename;
  const { pair, timeframe, startDate, endDate } = dataset.meta || {};
  const parts = ["trades", pair, startDate, endDate, timeframe].filter(Boolean);
  return `${parts.join("_")}.csv`;
}

function downloadDatasetCSV(dataset) {
  const csv = dataset.rawCsv?.trim() ? dataset.rawCsv : tradesToCSV(dataset.trades);
  const filename = buildExportFilename(dataset);
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getSlFilterInfo(trades) {
  const pcts = validTrades(trades)
    .filter((t) => t.result === "TP" || t.result === "SL")
    .map(tradeSlPct)
    .filter((p) => p > 0);
  if (!pcts.length) return { minSl: null, belowCount: 0, status: "unknown" };
  const minSl = Math.min(...pcts);
  const belowCount = pcts.filter((p) => p < SL_FILTER_THRESHOLD).length;
  if (belowCount === 0) return { minSl, belowCount: 0, status: "filtered" };
  return { minSl, belowCount, status: "includes" };
}

function SlFilterBadge({ trades, compact = false }) {
  const info = getSlFilterInfo(trades);
  if (info.status === "unknown") return null;
  const filtered = info.status === "filtered";
  const label = filtered ? "≥0.6%" : (compact ? "<0.6%" : `<0.6% (${info.belowCount})`);
  const title = filtered
    ? `Min SL: ${info.minSl.toFixed(2)}% — 0.6% alti islem yok`
    : `Min SL: ${info.minSl.toFixed(2)}% — ${info.belowCount} islem 0.6% altinda`;
  return (
    <span title={title} style={{
      fontSize: 9,
      color: filtered ? C.orange : "#c9a227",
      border: `1px solid ${filtered ? "rgba(255,140,66,0.45)" : "rgba(201,162,39,0.4)"}`,
      borderRadius: 3,
      padding: "1px 5px",
      lineHeight: 1.2,
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function wrEvolution(list) {
  let tp = 0, sl = 0;
  return list.map((t, i) => {
    if (t.result === "TP") tp++; else sl++;
    return { x: i + 1, wr: +((tp / (tp + sl)) * 100).toFixed(2), tp, sl };
  });
}

function slDistribution(trades) {
  return SL_BUCKETS.map((b) => {
    const inn = trades.filter((t) => {
      const p = tradeSlPct(t);
      return p >= b.min && p < b.max;
    });
    const tp  = inn.filter((t) => t.result === "TP").length;
    const sl  = inn.filter((t) => t.result === "SL").length;
    const tot = tp + sl;
    return { label: b.label, tp, sl, total: tot, wr: tot ? +((tp / tot) * 100).toFixed(1) : 0 };
  });
}

function calcEquity(trades, startBal) {
  let bal = startBal, peak = startBal, maxDD = 0;
  const pts = [{ x: 0, bal: +startBal.toFixed(2), dd: 0 }];
  trades.forEach((t, i) => {
    if (t.result === "TP") bal *= TP_MULT;
    else if (t.result === "SL") bal *= SL_MULT;
    if (bal > peak) peak = bal;
    const dd = +((peak - bal) / peak * 100).toFixed(2);
    if (dd > maxDD) maxDD = dd;
    pts.push({ x: i + 1, bal: +bal.toFixed(2), dd, result: t.result, month: t.month });
  });
  return { pts, maxDD: +maxDD.toFixed(2), finalBal: +bal.toFixed(2), gain: +(((bal - startBal) / startBal) * 100).toFixed(2) };
}

function calcStreaks(trades) {
  let maxTP = 0, maxSL = 0, curTP = 0, curSL = 0;
  const history = [];
  trades.forEach((t) => {
    if (t.result === "TP") { curTP++; curSL = 0; if (curTP > maxTP) maxTP = curTP; }
    else { curSL++; curTP = 0; if (curSL > maxSL) maxSL = curSL; }
    history.push({ tpStreak: curTP, slStreak: -curSL });
  });
  return { maxTP, maxSL, history };
}

function calcMonthly(trades) {
  const map = {};
  trades.forEach((t) => {
    if (!t.month) return;
    if (!map[t.month]) map[t.month] = { month: t.month, tp: 0, sl: 0 };
    if (t.result === "TP") map[t.month].tp++; else if (t.result === "SL") map[t.month].sl++;
  });
  return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    ...m,
    total:  m.tp + m.sl,
    wr:     m.tp + m.sl ? +((m.tp / (m.tp + m.sl)) * 100).toFixed(1) : 0,
    totalR: +(m.tp - m.sl).toFixed(1),
  }));
}

function calcConflict(trades) {
  return ["none","same-bar","later"].map((ct) => {
    const g  = trades.filter((t) => t.conflictType === ct);
    const tp = g.filter((t) => t.result === "TP").length;
    const sl = g.filter((t) => t.result === "SL").length;
    const cn = g.filter((t) => t.result === "CONFLICT").length;
    return { type: ct, total: g.length, tp, sl, conflict: cn, wr: tp + sl ? +((tp / (tp + sl)) * 100).toFixed(1) : 0 };
  });
}

const wrColor  = (wr) => wr >= 55 ? C.green : wr >= 45 ? C.orange : C.red;
const pnlColor = (v)  => v >= 0 ? C.green : C.red;
const fmtBal   = (v)  => v >= 1000 ? `$${(v / 1000).toFixed(2)}K` : `$${v.toFixed(2)}`;

function calcWinRates(trades) {
  const valid  = validTrades(trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const tpAll  = valid.filter((t) => t.result === "TP").length;
  const tpL    = longs.filter((t) => t.result === "TP").length;
  const tpS    = shorts.filter((t) => t.result === "TP").length;
  return {
    wrAll: valid.length  ? +((tpAll / valid.length) * 100).toFixed(1)  : null,
    wrL:   longs.length  ? +((tpL   / longs.length)  * 100).toFixed(1)  : null,
    wrS:   shorts.length ? +((tpS   / shorts.length) * 100).toFixed(1)  : null,
    total: valid.length,
    longCount: longs.length,
    shortCount: shorts.length,
  };
}

function parseTradeDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function getTradeDateRange(trades) {
  let first = null;
  let last = null;
  (trades || []).forEach((t) => {
    [t.entryTime, t.exitTime].forEach((val) => {
      const d = parseTradeDate(val);
      if (!d) return;
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
    });
  });
  return {
    start: first ? first.toISOString().slice(0, 10) : "",
    end: last ? last.toISOString().slice(0, 10) : "",
  };
}

function tradeEntryDateKey(t) {
  const d = parseTradeDate(t.entryTime);
  return d ? d.toISOString().slice(0, 10) : "";
}

function filterTradesByDateRange(trades, startDate, endDate) {
  if (!startDate && !endDate) return trades || [];
  let start = startDate;
  let end = endDate;
  if (start && end && start > end) [start, end] = [end, start];
  return (trades || []).filter((t) => {
    const key = tradeEntryDateKey(t);
    if (!key) return false;
    if (start && key < start) return false;
    if (end && key > end) return false;
    return true;
  });
}

const RANK_WR_COLS = [
  { id: "all",   key: "wrAll", label: "Genel WR"  },
  { id: "long",  key: "wrL",   label: "Long WR"   },
  { id: "short", key: "wrS",   label: "Short WR"  },
];

const RANK_SORTS = [
  { id: "all",  label: "Genel Win Rate"  },
  { id: "long", label: "Long Win Rate"   },
  { id: "short", label: "Short Win Rate" },
];

function RankingModal({
  datasets,
  sortBy,
  onSortByChange,
  minTradesInput,
  onMinTradesInputChange,
  exchangeFilter,
  onExchangeFilterChange,
  dateStart,
  dateEnd,
  onDateStartChange,
  onDateEndChange,
  onSelectDataset,
  onClose,
}) {

  const minTrades = Math.max(0, parseInt(minTradesInput, 10) || 0);
  const exchangeOptions = ["ALL", ...Array.from(new Set(Object.values(datasets).map((d) => d.meta.exchange || "UNKNOWN"))).sort()];
  const selectedExchange = exchangeFilter || "ALL";
  const dateFilterActive = Boolean(dateStart || dateEnd);

  const rows = Object.entries(datasets)
    .map(([key, ds]) => {
      const trades = dateFilterActive
        ? filterTradesByDateRange(ds.trades, dateStart, dateEnd)
        : ds.trades;
      const rates = calcWinRates(trades);
      const slInfo = getSlFilterInfo(trades);
      return {
        key,
        pair: coinSymbol(ds.meta.pair),
        exchange: ds.meta.exchange || "UNKNOWN",
        timeframe: ds.meta.timeframe,
        startDate: ds.meta.startDate,
        endDate: ds.meta.endDate,
        slInfo,
        filteredTrades: trades,
        ...rates,
      };
    })
    .filter((r) => r.total >= minTrades)
    .filter((r) => selectedExchange === "ALL" || r.exchange === selectedExchange);

  const sortKey = sortBy === "long" ? "wrL" : sortBy === "short" ? "wrS" : "wrAll";
  rows.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va;
  });

  const fmtWR = (v) => v == null ? "—" : `${v}%`;

  const wrColOrder = [
    RANK_WR_COLS.find((c) => c.id === sortBy),
    ...RANK_WR_COLS.filter((c) => c.id !== sortBy),
  ];

  const thStyle = { padding: "8px 10px", textAlign: "left", color: C.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.25)", position: "sticky", top: 0 };
  const tdStyle = { padding: "10px" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9997, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, width: "100%", maxWidth: 820, maxHeight: "85vh", display: "flex", flexDirection: "column", fontFamily: "monospace", boxShadow: "0 24px 80px rgba(0,0,0,0.9)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.textBright, letterSpacing: 2 }}>SIRALAMA</div>
            <div style={{ fontSize: 9, color: C.muted, marginTop: 4, letterSpacing: 1 }}>
              {rows.length} analiz
              {dateFilterActive && (
                <span style={{ color: C.orange }}> · {dateStart || "..."} — {dateEnd || "..."}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, width: 32, height: 32, borderRadius: 4, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 6, padding: "12px 20px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap", alignItems: "center" }}>
          {RANK_SORTS.map((s) => (
            <button key={s.id} onClick={() => onSortByChange(s.id)}
              style={{ padding: "6px 14px", borderRadius: 3, cursor: "pointer", fontSize: 10, letterSpacing: 0.5, transition: "all .15s",
                background: sortBy === s.id ? "rgba(0,229,160,0.12)" : "transparent",
                border: `1px solid ${sortBy === s.id ? "rgba(0,229,160,0.35)" : "rgba(255,255,255,0.08)"}`,
                color: sortBy === s.id ? C.green : C.muted }}>
              {s.label}
            </button>
          ))}
          <div style={{ width: 1, height: 24, background: C.border, margin: "0 4px" }} />
          <span style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>Minimum Islem Sayisi</span>
          <input
            type="number"
            min={0}
            value={minTradesInput}
            onChange={(e) => onMinTradesInputChange(e.target.value)}
            placeholder="0"
            style={{ width: 72, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, color: C.textBright, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
          />
          <span style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, marginLeft: 8 }}>Borsa</span>
          <select
            value={selectedExchange}
            onChange={(e) => onExchangeFilterChange(e.target.value)}
            style={{ minWidth: 120, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, color: C.textBright, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
          >
            {exchangeOptions.map((ex) => (
              <option key={ex} value={ex}>{ex === "ALL" ? "Tum Borsalar" : ex}</option>
            ))}
          </select>
        </div>

        <div style={{
          display: "flex", gap: 8, padding: "10px 20px", borderBottom: `1px solid ${C.border}`,
          flexWrap: "wrap", alignItems: "center",
          background: dateFilterActive ? "rgba(255,140,66,0.06)" : "transparent",
        }}>
          <span style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>Tarih Filtresi</span>
          <input
            type="date"
            value={dateStart}
            max={dateEnd || undefined}
            onChange={(e) => onDateStartChange(e.target.value)}
            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, color: C.textBright, padding: "5px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
          />
          <span style={{ color: C.muted, fontSize: 11 }}>—</span>
          <input
            type="date"
            value={dateEnd}
            min={dateStart || undefined}
            onChange={(e) => onDateEndChange(e.target.value)}
            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, color: C.textBright, padding: "5px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
          />
          <button
            onClick={() => { onDateStartChange(""); onDateEndChange(""); }}
            style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, padding: "5px 12px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace" }}
          >
            Temizle
          </button>
          {dateFilterActive && (
            <span style={{ fontSize: 10, color: C.orange }}>Giris tarihine gore WR</span>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>
          {rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 12 }}>
              {Object.keys(datasets).length === 0 ? "Henuz analiz yok." : "Bu filtreye uyan analiz yok."}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 12 }}>
              <thead>
                <tr>
                  {["#", "Parite", "TF", "SL", "Tarih", ...wrColOrder.map((c) => c.label), "Islem"].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.key} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent" }}>
                    <td style={{ ...tdStyle, color: C.muted, fontSize: 10 }}>{i + 1}</td>
                    <td style={tdStyle}>
                      <button
                        onClick={() => onSelectDataset(r.key)}
                        style={{ background: "transparent", border: "none", padding: 0, margin: 0, color: C.textBright, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}
                      >
                        {r.pair}
                      </button>
                    </td>
                    <td style={{ ...tdStyle, color: C.text }}>{r.timeframe}</td>
                    <td style={tdStyle}>
                      <SlFilterBadge trades={r.filteredTrades} compact />
                    </td>
                    <td style={{ ...tdStyle, color: C.muted, fontSize: 10, whiteSpace: "nowrap" }}>
                      {r.startDate ? `${r.startDate.slice(0, 7)} › ${r.endDate?.slice(0, 7) || "—"}` : "—"}
                    </td>
                    {wrColOrder.map((col) => (
                      <td key={col.id} style={{ ...tdStyle, color: wrColor(r[col.key] ?? 0), fontWeight: sortBy === col.id ? 700 : 400 }}>
                        {fmtWR(r[col.key])}
                      </td>
                    ))}
                    <td style={{ ...tdStyle, color: C.muted, fontSize: 10 }}>{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  EDITABLE INLINE
// ─────────────────────────────────────────────────────────────────────────────
function EditableText({ value, onSave, style, inputStyle }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  if (!editing) {
    return (
      <span onClick={() => setEditing(true)} style={{ cursor: "pointer", borderBottom: "1px dashed rgba(255,255,255,0.15)", ...style }}>
        {value || "—"}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
    else setDraft(value);
  };

  return (
    <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
      style={{ background: "rgba(0,229,160,0.08)", border: `1px solid rgba(0,229,160,0.3)`, borderRadius: 3, color: C.textBright, padding: "2px 6px", fontFamily: "monospace", outline: "none", width: "100%", ...inputStyle }} />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px 18px", flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: color || C.textBright }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function SecTitle({ children }) {
  return (
    <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 2, marginBottom: 14, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAB COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function OverviewTab({ data, totalTradeCount, isDateFilterActive }) {
  const { trades, meta, uploadedAt } = data;
  const valid  = validTrades(trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const tpAll  = valid.filter((t) => t.result === "TP").length;
  const slAll  = valid.filter((t) => t.result === "SL").length;
  const wrAll  = valid.length ? +((tpAll / valid.length) * 100).toFixed(1) : 0;
  const wrL    = longs.length  ? +((longs.filter((t) => t.result === "TP").length / longs.length) * 100).toFixed(1) : 0;
  const wrS    = shorts.length ? +((shorts.filter((t) => t.result === "TP").length / shorts.length) * 100).toFixed(1) : 0;
  const { maxTP, maxSL } = calcStreaks(valid);
  const conflictCount = trades.filter((t) => t.result === "CONFLICT").length;
  const slInfo = getSlFilterInfo(trades);
  const tradeSub = isDateFilterActive && totalTradeCount != null
    ? `${conflictCount} conflict haric · ${valid.length}/${totalTradeCount} (filtreli)`
    : `${conflictCount} conflict haric`;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatCard label="Toplam Islem"    value={valid.length}   sub={tradeSub} />
        <StatCard label="Genel Win Rate"  value={`${wrAll}%`}    color={wrColor(wrAll)}  sub={`${tpAll} TP  ${slAll} SL`} />
        <StatCard label="Long Win Rate"   value={`${wrL}%`}      color={wrColor(wrL)}    sub={`${longs.length} islem`} />
        <StatCard label="Short Win Rate"  value={`${wrS}%`}      color={wrColor(wrS)}    sub={`${shorts.length} islem`} />
        <StatCard label="Max Ust Uste TP" value={maxTP}          color={C.green} />
        <StatCard label="Max Ust Uste SL" value={maxSL}          color={C.red} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <SecTitle>TP / SL Orani</SecTitle>
        <div style={{ height: 10, borderRadius: 6, background: "rgba(255,71,87,0.2)", overflow: "hidden" }}>
          <div style={{ width: `${wrAll}%`, height: "100%", background: `linear-gradient(90deg,${C.green},#00c87a)`, transition: "width .5s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ color: C.green, fontSize: 11 }}>TP {tpAll} ({wrAll}%)</span>
          <span style={{ color: C.red,   fontSize: 11 }}>SL {slAll} ({(100 - wrAll).toFixed(1)}%)</span>
        </div>
      </div>
      <SecTitle>Dosya Bilgisi</SecTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(155px,1fr))", gap: 10 }}>
        {[
          ["Parite",    meta.pair],
          ["Dosya",     data.filename || "—"],
          ["Borsa",     meta.exchange || "UNKNOWN"],
          ["Kontrat",   meta.contractType === "P" ? "Perpetual" : (meta.contractType || "Spot")],
          ["Timeframe", meta.timeframe],
          ["Baslangic", meta.startDate || "—"],
          ["Bitis",     meta.endDate   || "—"],
          ["SL Filtre", slInfo.status === "filtered" ? "≥0.6% (alt islem yok)" : slInfo.status === "includes" ? `<0.6% (${slInfo.belowCount} islem)` : "—"],
          ["Min SL%",   slInfo.minSl != null ? `${slInfo.minSl.toFixed(2)}%` : "—"],
          ["Yuklendi",  new Date(uploadedAt).toLocaleDateString("tr-TR")],
        ].map(([k, v]) => (
          <div key={k} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 14px" }}>
            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{k}</div>
            <div style={{ fontSize: 12, color: C.textBright, fontFamily: "monospace" }}>{v || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WinRateTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");

  const WRChart = ({ chartData, title, color }) => {
    const final = chartData[chartData.length - 1]?.wr ?? 0;
    return (
      <div style={{ marginBottom: 30 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: C.textBright }}>{title}</div>
          <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: wrColor(final) }}>{final.toFixed(1)}%</div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 10 }} />
            <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={42} />
            <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <Tooltip formatter={(v, n) => [`${v.toFixed(2)}%`, n]} />
            <Line type="monotone" dataKey="wr" name="Win Rate" stroke={color} dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  return (
    <div>
      <WRChart chartData={wrEvolution(valid)}  title="Genel Win Rate"   color={C.blue}   />
      <WRChart chartData={wrEvolution(longs)}  title="Long Win Rate"    color={C.green}  />
      <WRChart chartData={wrEvolution(shorts)} title="Short Win Rate"   color={C.orange} />
    </div>
  );
}

function DistributionTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const [activeSeg, setActiveSeg] = useState("all");

  const segMap = {
    all:   { trades: valid,  label: "Tum Islemler", color: C.blue   },
    long:  { trades: longs,  label: "Sadece LONG",  color: C.green  },
    short: { trades: shorts, label: "Sadece SHORT", color: C.orange },
  };
  const seg  = segMap[activeSeg];
  const dist = slDistribution(seg.trades);

  const DistTable = ({ dist }) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{["SL% Araligi","Toplam","TP","SL","Win Rate"].map((h) => (
            <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: C.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.3)" }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {dist.map((d, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent" }}>
              <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.textBright }}>{d.label}%</td>
              <td style={{ padding: "9px 14px", color: C.text }}>{d.total}</td>
              <td style={{ padding: "9px 14px", color: C.green, fontWeight: 600 }}>{d.tp}</td>
              <td style={{ padding: "9px 14px", color: C.red, fontWeight: 600 }}>{d.sl}</td>
              <td style={{ padding: "9px 14px", color: wrColor(d.wr), fontWeight: 700, fontFamily: "monospace" }}>{d.total ? `${d.wr}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      {/* Segment selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
        {Object.entries(segMap).map(([id, s]) => (
          <button key={id} onClick={() => setActiveSeg(id)}
            style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
              background: activeSeg === id ? `rgba(${id === "long" ? "0,229,160" : id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
              border: `1px solid ${activeSeg === id ? s.color : "rgba(255,255,255,0.08)"}`,
              color: activeSeg === id ? s.color : C.muted }}>
            {s.label}
          </button>
        ))}
      </div>

      <SecTitle>Entry SL% Dagilimi — {seg.label}</SecTitle>
      {dist.every((d) => d.total === 0) ? (
        <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12 }}>Bu segment icin veri yok.</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={dist}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 11 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} />
              <Tooltip formatter={(v, n) => [v, n]} />
              <Bar dataKey="tp" name="TP" stackId="a" fill={C.green} />
              <Bar dataKey="sl" name="SL" stackId="a" fill={C.red} radius={[3,3,0,0]} />
              <Legend formatter={(v) => <span style={{ color: v === "tp" ? C.green : C.red, fontSize: 11 }}>{v.toUpperCase()}</span>} />
            </BarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 20 }}>
            <DistTable dist={dist} />
          </div>
        </>
      )}
    </div>
  );
}

function EquityTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");

  const [startBal, setStartBal] = useState(10000);
  const [inputVal, setInputVal] = useState("10000");
  const [activeEq, setActiveEq] = useState("all"); // "all" | "long" | "short"

  const tradeSet = activeEq === "long" ? longs : activeEq === "short" ? shorts : valid;
  const { pts, maxDD, finalBal, gain } = calcEquity(tradeSet, startBal);

  const eqTabs = [
    { id: "all",   label: "Tum Islemler", color: C.blue   },
    { id: "long",  label: "Sadece LONG",  color: C.green  },
    { id: "short", label: "Sadece SHORT", color: C.orange },
  ];
  const activeColor = eqTabs.find((t) => t.id === activeEq)?.color ?? C.blue;

  const EqChart = ({ pts, gain, startBal, gradId, ddGradId }) => (
    <>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={pts}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={gain >= 0 ? activeColor : C.red} stopOpacity={0.22} />
              <stop offset="95%" stopColor={gain >= 0 ? activeColor : C.red} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 10 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={fmtBal} width={74} />
          <ReferenceLine y={startBal} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
          <Tooltip formatter={(v) => [fmtBal(v), "Bakiye"]} />
          <Area type="monotone" dataKey="bal" name="Bakiye" stroke={gain >= 0 ? activeColor : C.red} fill={`url(#${gradId})`} strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 16 }}>
        <SecTitle>Drawdown</SecTitle>
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={pts}>
            <defs>
              <linearGradient id={ddGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.red} stopOpacity={0.28} />
                <stop offset="95%" stopColor={C.red} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 9 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 9 }} tickFormatter={(v) => `${v.toFixed(0)}%`} width={38} />
            <Tooltip formatter={(v) => [`${v.toFixed(2)}%`, "Drawdown"]} />
            <Area type="monotone" dataKey="dd" name="Drawdown" stroke={C.red} fill={`url(#${ddGradId})`} strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );

  return (
    <div>
      {/* Baslangic bakiyesi input */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Baslangic Bakiyesi ($)</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={inputVal} onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = parseFloat(inputVal); if (v > 0) setStartBal(v); } }}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textBright, padding: "7px 12px", fontSize: 14, fontFamily: "monospace", width: 130 }} />
            <button onClick={() => { const v = parseFloat(inputVal); if (v > 0) setStartBal(v); }}
              style={{ background: "rgba(0,229,160,0.1)", border: `1px solid rgba(0,229,160,0.3)`, color: C.green, padding: "7px 16px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
              Uygula
            </button>
          </div>
        </div>
      </div>

      {/* Segment tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
        {eqTabs.map((t) => (
          <button key={t.id} onClick={() => setActiveEq(t.id)}
            style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
              background: activeEq === t.id ? `rgba(${t.id === "long" ? "0,229,160" : t.id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
              border: `1px solid ${activeEq === t.id ? t.color : "rgba(255,255,255,0.08)"}`,
              color: activeEq === t.id ? t.color : C.muted }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatCard label="Islem Sayisi"   value={tradeSet.length}                   color={C.textBright} />
        <StatCard label="Final Bakiye"   value={fmtBal(finalBal)}                  color={pnlColor(gain)} />
        <StatCard label="Toplam Getiri"  value={`${gain > 0 ? "+" : ""}${gain}%`}  color={pnlColor(gain)} />
        <StatCard label="Max Drawdown"   value={`${maxDD.toFixed(1)}%`}             color={C.red} />
        <StatCard label="Net Kar/Zarar"  value={fmtBal(finalBal - startBal)}        color={pnlColor(finalBal - startBal)} />
      </div>

      <SecTitle>
        Bakiye Grafigi —{" "}
        {activeEq === "all" ? "Tum Islemler" : activeEq === "long" ? "Sadece LONG" : "Sadece SHORT"}
      </SecTitle>
      <EqChart pts={pts} gain={gain} startBal={startBal} gradId={`eqGrad_${activeEq}`} ddGradId={`ddGrad_${activeEq}`} />
    </div>
  );
}

function StreaksTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const [activeSeg, setActiveSeg] = useState("all");

  const segMap = {
    all:   { trades: valid,  label: "Tum Islemler", color: C.blue   },
    long:  { trades: longs,  label: "Sadece LONG",  color: C.green  },
    short: { trades: shorts, label: "Sadece SHORT", color: C.orange },
  };
  const seg = segMap[activeSeg];
  const { maxTP, maxSL, history } = calcStreaks(seg.trades);
  const chartData = history.map((h, i) => ({ x: i + 1, ...h }));

  const SegButton = ({ id }) => (
    <button onClick={() => setActiveSeg(id)}
      style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
        background: activeSeg === id ? `rgba(${id === "long" ? "0,229,160" : id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
        border: `1px solid ${activeSeg === id ? segMap[id].color : "rgba(255,255,255,0.08)"}`,
        color: activeSeg === id ? segMap[id].color : C.muted }}>
      {segMap[id].label}
    </button>
  );

  return (
    <div>
      {/* Segment selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        <SegButton id="all" /><SegButton id="long" /><SegButton id="short" />
      </div>

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        <StatCard label="Islem Sayisi"     value={seg.trades.length}  color={C.textBright} />
        <StatCard label="Max Ust Uste TP"  value={maxTP}              color={C.green} sub="Ardisik TP serisi" />
        <StatCard label="Max Ust Uste SL"  value={maxSL}              color={C.red}   sub="Ardisik SL serisi" />
      </div>

      {/* Streak chart */}
      <SecTitle>Seri Gecmisi — {seg.label}</SecTitle>
      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} barSize={4}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 9 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 9 }} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
            <Tooltip formatter={(v, n) => [Math.abs(v), n]} />
            <Bar dataKey="tpStreak" name="TP Serisi" fill={C.green} />
            <Bar dataKey="slStreak" name="SL Serisi" fill={C.red} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12 }}>Bu segment için veri yok.</div>
      )}

      {/* Carpan hesabi */}
      <div style={{ marginTop: 24 }}>
        <SecTitle>Carpan Etki Hesabi — {seg.label} (Komisyon Dahil)</SecTitle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(195px,1fr))", gap: 10 }}>
          {[
            { label: `${maxTP}x ust uste TP`, mult: Math.pow(TP_MULT, maxTP), color: C.green },
            { label: `${maxSL}x ust uste SL`, mult: Math.pow(SL_MULT, maxSL), color: C.red   },
            { label: "10x TP ardisik",         mult: Math.pow(TP_MULT, 10),   color: C.green },
            { label: "10x SL ardisik",         mult: Math.pow(SL_MULT, 10),   color: C.red   },
          ].map((s) => (
            <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: C.muted, marginBottom: 6 }}>{s.label}</div>
              <div style={{ fontSize: 18, fontFamily: "monospace", fontWeight: 700, color: s.color }}>
                {s.mult >= 1 ? "+" : ""}{((s.mult - 1) * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>$10.000 → {fmtBal(10000 * s.mult)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConflictTab({ data }) {
  const analysis = calcConflict(data.trades);
  return (
    <div>
      <SecTitle>Conflict Tipi Bazli Performans</SecTitle>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        {analysis.map((a) => (
          <div key={a.type} style={{ flex: 1, minWidth: 150, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px 18px" }}>
            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>{a.type}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: wrColor(a.wr), fontFamily: "monospace" }}>{a.wr}%</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>Win Rate</div>
            <div style={{ marginTop: 10, display: "flex", gap: 12 }}>
              <span style={{ fontSize: 11, color: C.green }}>TP {a.tp}</span>
              <span style={{ fontSize: 11, color: C.red   }}>SL {a.sl}</span>
              {a.conflict > 0 && <span style={{ fontSize: 11, color: C.orange }}>CONF {a.conflict}</span>}
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>Toplam: {a.total}</div>
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={analysis}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="type" tick={{ fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} />
          <Tooltip formatter={(v, n) => [v, n]} />
          <Bar dataKey="tp" name="TP" stackId="a" fill={C.green} />
          <Bar dataKey="sl" name="SL" stackId="a" fill={C.red} radius={[3,3,0,0]} />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 22 }}>
        <SecTitle>Aciklama</SecTitle>
        {[
          ["none",     C.green,  "Cakisma yok. En temiz sinyal."],
          ["same-bar", C.orange, "Ayni bar cakismasi. CONFLICT result haric tutulur."],
          ["later",    C.blue,   "Sonraki bar cakismasi. Islem gecerli sayilir."],
        ].map(([type, color, desc]) => (
          <div key={type} style={{ display: "flex", gap: 12, padding: "10px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, marginBottom: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 3, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 11, color: C.textBright, marginBottom: 2, fontFamily: "monospace" }}>{type}</div>
              <div style={{ fontSize: 10, color: C.muted }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthlyTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const [activeSeg, setActiveSeg] = useState("all");

  const segMap = {
    all:   { trades: valid,  label: "Tum Islemler", color: C.blue   },
    long:  { trades: longs,  label: "Sadece LONG",  color: C.green  },
    short: { trades: shorts, label: "Sadece SHORT", color: C.orange },
  };
  const seg = segMap[activeSeg];
  const monthly = calcMonthly(seg.trades);

  const MonthTable = ({ data }) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{["Ay","Toplam","TP","SL","Total R","Win Rate"].map((h) => (
            <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: C.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.3)" }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {data.map((m, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent" }}>
              <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.textBright }}>{m.month}</td>
              <td style={{ padding: "9px 14px", color: C.text }}>{m.total}</td>
              <td style={{ padding: "9px 14px", color: C.green, fontWeight: 600 }}>{m.tp}</td>
              <td style={{ padding: "9px 14px", color: C.red, fontWeight: 600 }}>{m.sl}</td>
              <td style={{ padding: "9px 14px" }}>
                <span style={{ color: m.totalR >= 0 ? C.green : C.red, fontWeight: 700, fontFamily: "monospace" }}>
                  {m.totalR >= 0 ? "+" : ""}{m.totalR}R
                </span>
              </td>
              <td style={{ padding: "9px 14px" }}>
                <span style={{ color: wrColor(m.wr), fontWeight: 700, fontFamily: "monospace" }}>{m.wr}%</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      {/* Segment selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {Object.entries(segMap).map(([id, s]) => (
          <button key={id} onClick={() => setActiveSeg(id)}
            style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
              background: activeSeg === id ? `rgba(${id === "long" ? "0,229,160" : id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
              border: `1px solid ${activeSeg === id ? s.color : "rgba(255,255,255,0.08)"}`,
              color: activeSeg === id ? s.color : C.muted }}>
            {s.label}
          </button>
        ))}
      </div>

      <SecTitle>Aylik Performans — {seg.label}</SecTitle>

      {monthly.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12 }}>Bu segment için veri yok.</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthly}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 9 }} />
              <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={40} />
              <ReferenceLine y={50} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
              <Tooltip formatter={(v) => [`${v}%`, "Win Rate"]} />
              <Bar dataKey="wr" name="Win Rate" radius={[3,3,0,0]}>
                {monthly.map((m, i) => <Cell key={i} fill={wrColor(m.wr)} fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 20 }}>
            <MonthTable data={monthly} />
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [datasets,    setDatasets]    = useState({});
  const [selectedKey, setSelectedKey] = useState(null);
  const [activeTab,   setActiveTab]   = useState("overview");
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [dragOver,    setDragOver]    = useState(false);
  const [toast,       setToast]       = useState(null);
  const [confirmDel,  setConfirmDel]  = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSort, setSidebarSort] = useState("coin"); // "coin" | "timeframe" | "exchange"
  const [pairFilter,  setPairFilter]  = useState("");
  const [rankingOpen, setRankingOpen] = useState(false);
  const [rankingSortBy, setRankingSortBy] = useState("all");
  const [rankingMinTradesInput, setRankingMinTradesInput] = useState("");
  const [rankingExchangeFilter, setRankingExchangeFilter] = useState("ALL");
  const [rankingDateStart, setRankingDateStart] = useState("");
  const [rankingDateEnd, setRankingDateEnd] = useState("");
  const [analysisDateStart, setAnalysisDateStart] = useState("");
  const [analysisDateEnd, setAnalysisDateEnd] = useState("");
  const fileRef = useRef();
  const pendingAnalysisDates = useRef(null);

  useEffect(() => {
    dbLoadAll()
      .then((all) => { setDatasets(all); setLoading(false); })
      .catch(() => { setLoading(false); showToast("Veritabani baglantisi kurulamadi!", "err"); });
  }, []);

  useEffect(() => {
    const ds = selectedKey ? datasets[selectedKey] : null;
    if (!ds?.trades?.length) {
      setAnalysisDateStart("");
      setAnalysisDateEnd("");
      return;
    }
    if (pendingAnalysisDates.current) {
      const { start, end } = pendingAnalysisDates.current;
      pendingAnalysisDates.current = null;
      setAnalysisDateStart(start);
      setAnalysisDateEnd(end);
      return;
    }
    const range = getTradeDateRange(ds.trades);
    setAnalysisDateStart(range.start || ds.meta.startDate || "");
    setAnalysisDateEnd(range.end || ds.meta.endDate || "");
  }, [selectedKey]);

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const readFileAsText = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error(`Dosya okunamadi: ${file.name}`));
      reader.readAsText(file, "utf-8");
    });

  const askExchangeForFile = (fileName) => {
    if (typeof window === "undefined") return "UNKNOWN";
    const answer = window.prompt(
      `"${fileName}" dosyasi icin borsa bulunamadi.\nLutfen borsa adini gir (or: MEXC, BINANCE, IBKR):`,
      ""
    );
    const normalized = (answer || "").trim().toUpperCase();
    return normalized || "UNKNOWN";
  };

  const handleFiles = useCallback(async (fileList) => {
    if (!fileList?.length) return;
    const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".csv"));
    if (!files.length) {
      showToast("CSV dosyasi bulunamadi.", "err");
      return;
    }

    setSaving(true);
    setUploadProgress({ current: 0, total: files.length });

    let lastKey = null;
    let lastDataset = null;
    let ok = 0;
    let fail = 0;
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress({ current: i + 1, total: files.length });
      try {
        const text = await readFileAsText(file);
        const inferredExchange = inferExchangeFromFilename(file.name);
        const exchange = inferredExchange || askExchangeForFile(file.name);
        const dataset = { ...parseCSV(text, file.name, exchange), rawCsv: text };
        const key = dataset.meta.storageKey;
        await dbSaveDataset(key, dataset);
        setDatasets((prev) => ({ ...prev, [key]: dataset }));
        lastKey = key;
        lastDataset = dataset;
        ok++;
      } catch (err) {
        fail++;
        errors.push(`${file.name}: ${err.message}`);
      }
    }

    if (lastKey) {
      setSelectedKey(lastKey);
      setActiveTab("overview");
    }

    if (fail === 0) {
      showToast(
        ok === 1
          ? `Kaydedildi → ${lastDataset.meta.pair} / ${lastDataset.meta.timeframe}`
          : `${ok} dosya kaydedildi.`,
        "ok"
      );
    } else if (ok === 0) {
      showToast(errors[0] || "Yukleme basarisiz.", "err");
    } else {
      showToast(`${ok} kaydedildi, ${fail} hata.`, "err");
    }

    setSaving(false);
    setUploadProgress(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const handleDelete = async (key) => {
    try {
      await dbDeleteDataset(key);
      setDatasets((prev) => { const n = { ...prev }; delete n[key]; return n; });
      if (selectedKey === key) {
        const rem = Object.keys(datasets).filter((k) => k !== key);
        setSelectedKey(rem[0] ?? null);
      }
      showToast("Analiz silindi.", "ok");
    } catch (err) {
      showToast("Silme hatasi: " + err.message, "err");
    } finally {
      setConfirmDel(null);
    }
  };

  const handleMetaEdit = async (key, field, value) => {
    const ds = datasets[key];
    if (!ds) return;
    const updated = { ...ds, meta: { ...ds.meta, [field]: value } };
    try {
      await dbSaveDataset(key, updated);
      setDatasets((prev) => ({ ...prev, [key]: updated }));
      showToast("Guncellendi", "ok");
    } catch (err) {
      showToast("Guncelleme hatasi: " + err.message, "err");
    }
  };

  const normalizedPairFilter = pairFilter.trim().toLowerCase();
  const filteredDatasetEntries = Object.entries(datasets).filter(([, ds]) => {
    if (!normalizedPairFilter) return true;
    const symbol = coinSymbol(ds.meta.pair).toLowerCase();
    const fullPair = (ds.meta.pair || "").toLowerCase();
    return symbol.includes(normalizedPairFilter) || fullPair.includes(normalizedPairFilter);
  });

  // Sidebar tree — coin grouping
  const treeByCoin = {};
  filteredDatasetEntries.forEach(([key, ds]) => {
    const p = ds.meta.pair;
    if (!treeByCoin[p]) treeByCoin[p] = [];
    treeByCoin[p].push({ key, tf: ds.meta.timeframe, exchange: ds.meta.exchange || "UNKNOWN", startDate: ds.meta.startDate, endDate: ds.meta.endDate });
  });
  Object.values(treeByCoin).forEach((arr) => arr.sort((a, b) => tfSort(a.tf, b.tf)));
  const sortedPairs = Object.keys(treeByCoin).sort();

  // Sidebar tree — timeframe grouping
  const treeByTF = {};
  filteredDatasetEntries.forEach(([key, ds]) => {
    const tf = ds.meta.timeframe;
    if (!treeByTF[tf]) treeByTF[tf] = [];
    treeByTF[tf].push({ key, pair: ds.meta.pair, exchange: ds.meta.exchange || "UNKNOWN", startDate: ds.meta.startDate, endDate: ds.meta.endDate });
  });
  Object.values(treeByTF).forEach((arr) => arr.sort((a, b) => a.pair.localeCompare(b.pair)));
  const sortedTFs = Object.keys(treeByTF).sort((a, b) => tfSort(a, b));

  // Sidebar tree — exchange grouping
  const treeByExchange = {};
  filteredDatasetEntries.forEach(([key, ds]) => {
    const ex = ds.meta.exchange || "UNKNOWN";
    if (!treeByExchange[ex]) treeByExchange[ex] = [];
    treeByExchange[ex].push({ key, pair: ds.meta.pair, tf: ds.meta.timeframe, startDate: ds.meta.startDate, endDate: ds.meta.endDate });
  });
  Object.values(treeByExchange).forEach((arr) => arr.sort((a, b) => a.pair.localeCompare(b.pair) || tfSort(a.tf, b.tf)));
  const sortedExchanges = Object.keys(treeByExchange).sort();

  const data = selectedKey ? datasets[selectedKey] : null;
  const tradeDateRange = data ? getTradeDateRange(data.trades) : { start: "", end: "" };
  const filteredTrades = data
    ? filterTradesByDateRange(data.trades, analysisDateStart, analysisDateEnd)
    : [];
  const filteredData = data ? { ...data, trades: filteredTrades } : null;
  const totalTradeCount = data ? validTrades(data.trades).length : 0;
  const filteredTradeCount = filteredData ? validTrades(filteredData.trades).length : 0;
  const isDateFilterActive = Boolean(
    data && tradeDateRange.start && tradeDateRange.end
    && (analysisDateStart !== tradeDateRange.start || analysisDateEnd !== tradeDateRange.end)
  );
  const hasTradeDateRange = Boolean(tradeDateRange.start || tradeDateRange.end);
  const hasFileDateRange = Boolean(data?.meta.startDate || data?.meta.endDate);
  const dateRangeMismatch = hasTradeDateRange && hasFileDateRange
    && (tradeDateRange.start !== (data?.meta.startDate || "") || tradeDateRange.end !== (data?.meta.endDate || ""));

  const tabContent = () => {
    if (!filteredData) return null;
    switch (activeTab) {
      case "overview":     return <OverviewTab     data={filteredData} totalTradeCount={totalTradeCount} isDateFilterActive={isDateFilterActive} />;
      case "winrate":      return <WinRateTab      data={filteredData} />;
      case "distribution": return <DistributionTab data={filteredData} />;
      case "equity":       return <EquityTab       data={filteredData} />;
      case "streaks":      return <StreaksTab       data={filteredData} />;
      case "conflict":     return <ConflictTab      data={filteredData} />;
      case "monthly":      return <MonthlyTab       data={filteredData} />;
      default:             return null;
    }
  };

  if (loading) return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.bg, gap: 14, fontFamily: "monospace" }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.green, boxShadow: `0 0 20px ${C.green}` }} />
      <div style={{ color: C.green, fontSize: 11, letterSpacing: 2.5 }}>YUKLENIYOR...</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Mono','Fira Code',monospace", overflow: "hidden" }}>

      {/* Grid bg */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, backgroundImage: "linear-gradient(rgba(0,229,160,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,160,0.02) 1px,transparent 1px)", backgroundSize: "40px 40px" }} />

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, background: C.surface2, border: `1px solid ${toast.type === "ok" ? C.green : C.red}`, borderRadius: 4, padding: "10px 20px", fontSize: 11, color: toast.type === "ok" ? C.green : C.red, boxShadow: "0 8px 40px rgba(0,0,0,0.8)", fontFamily: "monospace", maxWidth: 360 }}>
          {toast.msg}
        </div>
      )}

      {/* Confirm Modal */}
      {confirmDel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.surface2, border: `1px solid ${C.red}`, borderRadius: 8, padding: "32px 36px", maxWidth: 380, width: "100%", textAlign: "center", fontFamily: "monospace" }}>
            <div style={{ fontSize: 32, marginBottom: 14, color: C.orange }}>!</div>
            <div style={{ color: C.textBright, fontSize: 14, marginBottom: 8 }}>Bu analizi silmek istediğine emin misin?</div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 24, lineHeight: 1.8 }}>
              {datasets[confirmDel]?.meta.pair} / {datasets[confirmDel]?.meta.timeframe}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setConfirmDel(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 24px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>Iptal</button>
              <button onClick={() => handleDelete(confirmDel)} style={{ background: "rgba(255,71,87,0.15)", border: `1px solid ${C.red}`, color: C.red, padding: "8px 24px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Sil</button>
            </div>
          </div>
        </div>
      )}

      {rankingOpen && (
        <RankingModal
          datasets={datasets}
          sortBy={rankingSortBy}
          onSortByChange={setRankingSortBy}
          minTradesInput={rankingMinTradesInput}
          onMinTradesInputChange={setRankingMinTradesInput}
          exchangeFilter={rankingExchangeFilter}
          onExchangeFilterChange={setRankingExchangeFilter}
          dateStart={rankingDateStart}
          dateEnd={rankingDateEnd}
          onDateStartChange={setRankingDateStart}
          onDateEndChange={setRankingDateEnd}
          onSelectDataset={(key) => {
            if (rankingDateStart || rankingDateEnd) {
              pendingAnalysisDates.current = { start: rankingDateStart, end: rankingDateEnd };
            }
            setSelectedKey(key);
            setActiveTab("overview");
            setRankingOpen(false);
          }}
          onClose={() => setRankingOpen(false)}
        />
      )}

      {/* HEADER */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 54, background: "rgba(7,12,17,0.98)", borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setSidebarOpen((v) => !v)} style={{ background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: "0 4px", lineHeight: 1 }}>☰</button>
          <span style={{ color: C.green, fontSize: 20 }}>◈</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 3, color: C.textBright }}>BACKTEST<span style={{ color: C.green }}>LAB</span></div>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: 2, textTransform: "uppercase" }}>Kripto · Algo · 1:1 RR</div>
          </div>
          <div style={{ width: 1, height: 28, background: C.border }} />
          <div style={{ fontSize: 10, color: C.muted }}>
            <span style={{ color: C.textBright, fontWeight: 700 }}>{Object.keys(datasets).length}</span> analiz
            {sortedPairs.length > 0 && <span> · <span style={{ color: C.textBright, fontWeight: 700 }}>{sortedPairs.length}</span> parite</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setRankingOpen(true)} style={{ background: "rgba(77,166,255,0.08)", border: `1px solid rgba(77,166,255,0.3)`, color: C.blue, padding: "7px 18px", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>
            Siralama
          </button>
          {saving && (
            <span style={{ fontSize: 10, color: C.green }}>
              {uploadProgress ? `Kaydediliyor ${uploadProgress.current}/${uploadProgress.total}...` : "Kaydediliyor..."}
            </span>
          )}
          <button onClick={() => fileRef.current.click()} style={{ background: "rgba(0,229,160,0.1)", border: `1px solid rgba(0,229,160,0.35)`, color: C.green, padding: "7px 18px", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>
            + CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" multiple style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* SIDEBAR */}
        {sidebarOpen && (
          <aside style={{ width: 240, borderRight: `1px solid ${C.border}`, background: "rgba(10,16,24,0.97)", overflowY: "auto", flexShrink: 0, display: "flex", flexDirection: "column" }}>
            {/* Sort toggle */}
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.2)", display: "flex", gap: 4 }}>
              {[{ id: "coin", label: "Coine Gore" }, { id: "timeframe", label: "TF'e Gore" }, { id: "exchange", label: "Borsaya Gore" }].map((s) => (
                <button key={s.id} onClick={() => setSidebarSort(s.id)}
                  style={{ flex: 1, padding: "4px 8px", borderRadius: 3, cursor: "pointer", fontSize: 9, fontFamily: "monospace", letterSpacing: 1, transition: "all .15s",
                    background: sidebarSort === s.id ? "rgba(0,229,160,0.1)" : "transparent",
                    border: `1px solid ${sidebarSort === s.id ? "rgba(0,229,160,0.3)" : "rgba(255,255,255,0.06)"}`,
                    color: sidebarSort === s.id ? C.green : C.muted }}>
                  {s.label}
                </button>
              ))}
            </div>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.14)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  value={pairFilter}
                  onChange={(e) => setPairFilter(e.target.value)}
                  placeholder="Parite filtrele (orn. BTC)"
                  aria-label="Parite filtreleme"
                  spellCheck={false}
                  style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textBright, padding: "7px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
                />
                {pairFilter && (
                  <button
                    onClick={() => setPairFilter("")}
                    style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 4, width: 26, height: 26, cursor: "pointer", fontSize: 12, lineHeight: 1 }}
                    aria-label="Filtreyi temizle"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div style={{ marginTop: 6, fontSize: 9, color: C.muted }}>
                {filteredDatasetEntries.length} / {Object.keys(datasets).length} analiz
              </div>
            </div>

            {Object.keys(datasets).length === 0 ? (
              <div style={{ padding: "28px 16px", fontSize: 10, color: C.muted, lineHeight: 1.9, textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.2 }}>◫</div>
                Kayitli analiz yok.<br />CSV yukleyerek basla.
              </div>
            ) : filteredDatasetEntries.length === 0 ? (
              <div style={{ padding: "20px 16px", fontSize: 10, color: C.muted, lineHeight: 1.8, textAlign: "center" }}>
                <div style={{ fontSize: 20, marginBottom: 8, opacity: 0.25 }}>⌕</div>
                Filtreye uygun parite bulunamadi.
              </div>
            ) : sidebarSort === "coin" ? (
              sortedPairs.map((pair) => (
                <div key={pair} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ padding: "9px 14px 5px", fontSize: 11, color: C.textBright, fontWeight: 700, letterSpacing: 2, background: "rgba(0,229,160,0.03)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green, display: "inline-block" }} />
                    <EditableText value={coinSymbol(pair)} onSave={(v) => { treeByCoin[pair].forEach(({ key }) => handleMetaEdit(key, "pair", v.toUpperCase() + "USDT")); }} style={{ color: C.textBright, fontSize: 11, fontWeight: 700, letterSpacing: 2 }} />
                    <span style={{ fontSize: 8, color: C.muted, marginLeft: "auto" }}>{treeByCoin[pair].length} TF</span>
                  </div>
                  {treeByCoin[pair].map(({ key, tf, exchange, startDate, endDate }) => {
                    const isActive = key === selectedKey;
                    return (
                      <div key={key} style={{ display: "flex", alignItems: "stretch", borderLeft: `2px solid ${isActive ? C.green : "transparent"}`, background: isActive ? "rgba(0,229,160,0.07)" : "transparent", transition: "all .15s" }}>
                        <div onClick={() => { setSelectedKey(key); setActiveTab("overview"); }} style={{ flex: 1, padding: "8px 14px 8px 18px", cursor: "pointer" }}>
                          <div style={{ fontSize: 12, color: isActive ? C.green : C.text, fontWeight: isActive ? 700 : 400, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <EditableText value={tf} onSave={(v) => handleMetaEdit(key, "timeframe", v)} style={{ color: isActive ? C.green : C.text, fontSize: 12, fontWeight: isActive ? 700 : 400 }} />
                            <span style={{ fontSize: 9, color: C.blue, border: "1px solid rgba(77,166,255,0.35)", borderRadius: 3, padding: "1px 5px", lineHeight: 1.2 }}>
                              {exchange || "UNKNOWN"}
                            </span>
                            <SlFilterBadge trades={datasets[key]?.trades || []} compact />
                          </div>
                          <div style={{ fontSize: 12, color: C.textBright, marginTop: 4, fontFamily: "monospace", fontWeight: 600 }}>
                            {startDate ? (
                              <span>
                                <EditableText value={startDate} onSave={(v) => handleMetaEdit(key, "startDate", v)} style={{ color: C.textBright, fontSize: 12 }} />
                                <span style={{ color: C.muted, margin: "0 4px" }}>›</span>
                                <EditableText value={endDate || ""} onSave={(v) => handleMetaEdit(key, "endDate", v)} style={{ color: C.textBright, fontSize: 12 }} />
                              </span>
                            ) : <span style={{ color: C.muted }}>—</span>}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setConfirmDel(key); }}
                          style={{ background: "transparent", border: "none", color: "rgba(255,71,87,0.3)", cursor: "pointer", padding: "0 10px", fontSize: 12, transition: "color .15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = C.red)}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,71,87,0.3)")}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            ) : sidebarSort === "timeframe" ? (
              sortedTFs.map((tf) => (
                <div key={tf} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ padding: "9px 14px 5px", fontSize: 11, color: C.textBright, fontWeight: 700, letterSpacing: 2, background: "rgba(77,166,255,0.03)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.blue, display: "inline-block" }} />
                    {tf}
                    <span style={{ fontSize: 8, color: C.muted, marginLeft: "auto" }}>{treeByTF[tf].length} coin</span>
                  </div>
                  {treeByTF[tf].map(({ key, pair, exchange, startDate, endDate }) => {
                    const isActive = key === selectedKey;
                    return (
                      <div key={key} style={{ display: "flex", alignItems: "stretch", borderLeft: `2px solid ${isActive ? C.green : "transparent"}`, background: isActive ? "rgba(0,229,160,0.07)" : "transparent", transition: "all .15s" }}>
                        <div onClick={() => { setSelectedKey(key); setActiveTab("overview"); }} style={{ flex: 1, padding: "8px 14px 8px 18px", cursor: "pointer" }}>
                          <div style={{ fontSize: 12, color: isActive ? C.green : C.text, fontWeight: isActive ? 700 : 400, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <EditableText value={coinSymbol(pair)} onSave={(v) => handleMetaEdit(key, "pair", v.toUpperCase() + "USDT")} style={{ color: isActive ? C.green : C.text, fontSize: 12, fontWeight: isActive ? 700 : 400 }} />
                            <span style={{ fontSize: 9, color: C.blue, border: "1px solid rgba(77,166,255,0.35)", borderRadius: 3, padding: "1px 5px", lineHeight: 1.2 }}>
                              {exchange || "UNKNOWN"}
                            </span>
                            <SlFilterBadge trades={datasets[key]?.trades || []} compact />
                          </div>
                          <div style={{ fontSize: 12, color: C.textBright, marginTop: 4, fontFamily: "monospace", fontWeight: 600 }}>
                            {startDate ? (
                              <span>
                                <EditableText value={startDate} onSave={(v) => handleMetaEdit(key, "startDate", v)} style={{ color: C.textBright, fontSize: 12 }} />
                                <span style={{ color: C.muted, margin: "0 4px" }}>›</span>
                                <EditableText value={endDate || ""} onSave={(v) => handleMetaEdit(key, "endDate", v)} style={{ color: C.textBright, fontSize: 12 }} />
                              </span>
                            ) : <span style={{ color: C.muted }}>—</span>}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setConfirmDel(key); }}
                          style={{ background: "transparent", border: "none", color: "rgba(255,71,87,0.3)", cursor: "pointer", padding: "0 10px", fontSize: 12, transition: "color .15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = C.red)}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,71,87,0.3)")}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            ) : (
              sortedExchanges.map((exchange) => (
                <div key={exchange} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ padding: "9px 14px 5px", fontSize: 11, color: C.textBright, fontWeight: 700, letterSpacing: 2, background: "rgba(77,166,255,0.03)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.blue, display: "inline-block" }} />
                    {exchange}
                    <span style={{ fontSize: 8, color: C.muted, marginLeft: "auto" }}>{treeByExchange[exchange].length} analiz</span>
                  </div>
                  {treeByExchange[exchange].map(({ key, pair, tf, startDate, endDate }) => {
                    const isActive = key === selectedKey;
                    return (
                      <div key={key} style={{ display: "flex", alignItems: "stretch", borderLeft: `2px solid ${isActive ? C.green : "transparent"}`, background: isActive ? "rgba(0,229,160,0.07)" : "transparent", transition: "all .15s" }}>
                        <div onClick={() => { setSelectedKey(key); setActiveTab("overview"); }} style={{ flex: 1, padding: "8px 14px 8px 18px", cursor: "pointer" }}>
                          <div style={{ fontSize: 12, color: isActive ? C.green : C.text, fontWeight: isActive ? 700 : 400, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <EditableText value={coinSymbol(pair)} onSave={(v) => handleMetaEdit(key, "pair", v.toUpperCase() + "USDT")} style={{ color: isActive ? C.green : C.text, fontSize: 12, fontWeight: isActive ? 700 : 400 }} />
                            <span style={{ fontSize: 9, color: C.green }}>{tf}</span>
                            <SlFilterBadge trades={datasets[key]?.trades || []} compact />
                          </div>
                          <div style={{ fontSize: 12, color: C.textBright, marginTop: 4, fontFamily: "monospace", fontWeight: 600 }}>
                            {startDate ? `${startDate.slice(0,7)} › ${endDate?.slice(0,7) || "—"}` : "—"}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setConfirmDel(key); }}
                          style={{ background: "transparent", border: "none", color: "rgba(255,71,87,0.3)", cursor: "pointer", padding: "0 10px", fontSize: 12, transition: "color .15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = C.red)}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,71,87,0.3)")}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              onClick={() => fileRef.current.click()}
              style={{ margin: 12, marginTop: "auto", border: `1px dashed ${dragOver ? C.green : "rgba(255,255,255,0.1)"}`, borderRadius: 6, padding: "14px 10px", textAlign: "center", cursor: "pointer", transition: "all .2s" }}>
              <div style={{ fontSize: 18, color: dragOver ? C.green : "rgba(255,255,255,0.15)", marginBottom: 4 }}>+</div>
              <div style={{ fontSize: 9, color: C.muted }}>CSV surukle / toplu yukle</div>
            </div>
          </aside>
        )}

        {/* MAIN */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!data ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: 32, textAlign: "center" }}>
              <div style={{ fontSize: 52, opacity: 0.1 }}>◈</div>
              <div style={{ fontSize: 15, color: C.textBright }}>
                {Object.keys(datasets).length > 0 ? "Soldaki agactan bir analiz sec" : "Ilk CSV dosyani yukle"}
              </div>
              <div style={{ fontSize: 10, color: C.muted, maxWidth: 480, lineHeight: 1.9 }}>
                Desteklenen formatlar:<br />
                <code style={{ color: C.green }}>xlm_4h.csv</code> &nbsp;·&nbsp;
                <code style={{ color: C.green }}>btc_1d.csv</code> &nbsp;·&nbsp;
                <code style={{ color: C.green }}>new_trades_XLMUSDT_P_2025-01-01_2026-02-28_4h.csv</code>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(10,16,24,0.85)", flexShrink: 0, flexWrap: "wrap" }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.textBright, letterSpacing: 3 }}>
                  <EditableText value={coinSymbol(data.meta.pair)} onSave={(v) => handleMetaEdit(selectedKey, "pair", v.toUpperCase() + "USDT")} style={{ color: C.textBright, fontSize: 18, fontWeight: 700, letterSpacing: 3 }} />
                </span>
                <span style={{ color: C.muted, fontSize: 16 }}>›</span>
                <span style={{ color: C.green, border: `1px solid rgba(0,229,160,0.3)`, padding: "2px 12px", borderRadius: 2, fontSize: 12, fontFamily: "monospace" }}>
                  <EditableText value={data.meta.timeframe} onSave={(v) => handleMetaEdit(selectedKey, "timeframe", v)} style={{ color: C.green, fontSize: 12 }} />
                </span>
                <span style={{ color: C.blue, border: `1px solid rgba(77,166,255,0.3)`, padding: "2px 10px", borderRadius: 2, fontSize: 11, fontFamily: "monospace" }}>
                  <EditableText value={data.meta.exchange || "UNKNOWN"} onSave={(v) => handleMetaEdit(selectedKey, "exchange", v.toUpperCase())} style={{ color: C.blue, fontSize: 11 }} />
                </span>
                <SlFilterBadge trades={isDateFilterActive ? filteredTrades : data.trades} />
                {data.meta.contractType === "P" && <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>Perpetual</span>}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                  {data.meta.startDate && (
                    <span style={{ fontSize: 13, color: C.textBright, fontFamily: "monospace", fontWeight: 600 }}>
                      <EditableText value={data.meta.startDate} onSave={(v) => handleMetaEdit(selectedKey, "startDate", v)} style={{ color: C.textBright, fontSize: 13 }} />
                      <span style={{ color: C.muted, margin: "0 6px" }}>—</span>
                      <EditableText value={data.meta.endDate || ""} onSave={(v) => handleMetaEdit(selectedKey, "endDate", v)} style={{ color: C.textBright, fontSize: 13 }} />
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: isDateFilterActive ? C.orange : C.muted }}>
                    {isDateFilterActive ? `${filteredTradeCount} / ${totalTradeCount} islem` : `${totalTradeCount} islem`}
                  </span>
                  <button onClick={() => downloadDatasetCSV(data)} style={{ background: "rgba(77,166,255,0.08)", border: `1px solid rgba(77,166,255,0.25)`, color: C.blue, padding: "4px 12px", borderRadius: 3, cursor: "pointer", fontSize: 10 }}>Indir CSV</button>
                  <button onClick={() => setConfirmDel(selectedKey)} style={{ background: "rgba(255,71,87,0.08)", border: `1px solid rgba(255,71,87,0.25)`, color: "#ff6b7a", padding: "4px 12px", borderRadius: 3, cursor: "pointer", fontSize: 10 }}>Sil</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 2, padding: "8px 12px", borderBottom: `1px solid ${C.border}`, background: "rgba(7,12,17,0.75)", flexShrink: 0, overflowX: "auto" }}>
                {TABS.map((t) => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    style={{ background: activeTab === t.id ? "rgba(0,229,160,0.1)" : "transparent", border: `1px solid ${activeTab === t.id ? "rgba(0,229,160,0.3)" : "transparent"}`, color: activeTab === t.id ? C.green : C.muted, padding: "5px 14px", borderRadius: 3, cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", transition: "all .15s" }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
                borderBottom: `1px solid ${C.border}`,
                background: isDateFilterActive ? "rgba(255,140,66,0.06)" : "rgba(7,12,17,0.75)",
                flexShrink: 0, flexWrap: "wrap",
              }}>
                <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1.2, marginRight: 4 }}>Tarih Filtresi</span>
                <input
                  type="date"
                  value={analysisDateStart}
                  min={tradeDateRange.start || undefined}
                  max={analysisDateEnd || tradeDateRange.end || undefined}
                  onChange={(e) => setAnalysisDateStart(e.target.value)}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, color: C.textBright, padding: "5px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
                />
                <span style={{ color: C.muted, fontSize: 11 }}>—</span>
                <input
                  type="date"
                  value={analysisDateEnd}
                  min={analysisDateStart || tradeDateRange.start || undefined}
                  max={tradeDateRange.end || undefined}
                  onChange={(e) => setAnalysisDateEnd(e.target.value)}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, color: C.textBright, padding: "5px 10px", fontSize: 11, fontFamily: "monospace", outline: "none" }}
                />
                <button
                  onClick={() => {
                    setAnalysisDateStart(tradeDateRange.start || "");
                    setAnalysisDateEnd(tradeDateRange.end || "");
                  }}
                  style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, padding: "5px 12px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace" }}
                >
                  Tum Donem
                </button>
                {isDateFilterActive && (
                  <span style={{ fontSize: 10, color: C.orange, marginLeft: 4 }}>
                    {filteredTradeCount} islem · giris tarihine gore
                  </span>
                )}
                {filteredTradeCount === 0 && (analysisDateStart || analysisDateEnd) && (
                  <span style={{ fontSize: 10, color: C.red, marginLeft: 4 }}>Bu aralikta islem yok</span>
                )}
              </div>
              {hasTradeDateRange && (
                <div style={{ margin: "10px 16px 0", padding: "10px 12px", border: `1px solid ${dateRangeMismatch ? "rgba(255,140,66,0.45)" : "rgba(77,166,255,0.35)"}`, borderRadius: 6, background: dateRangeMismatch ? "rgba(255,140,66,0.08)" : "rgba(77,166,255,0.08)" }}>
                  <div style={{ fontSize: 10, color: dateRangeMismatch ? C.orange : C.blue, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 4 }}>
                    Islem Tarih Araligi Uyarisi
                  </div>
                  <div style={{ fontSize: 11, color: C.text, lineHeight: 1.6 }}>
                    CSV isminden: <span style={{ color: C.textBright, fontFamily: "monospace" }}>{(data.meta.startDate || "—")} — {(data.meta.endDate || "—")}</span>
                    {"  |  "}
                    Islemlerden hesaplanan: <span style={{ color: C.textBright, fontFamily: "monospace" }}>{tradeDateRange.start || "—"} — {tradeDateRange.end || "—"}</span>
                  </div>
                </div>
              )}
              <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
                {tabContent()}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
