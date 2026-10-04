// ==UserScript==
// @name         TV Chat Panel (unofficial)
// @namespace    tv-chat-panel
// @version      1.1
// @description  An unofficial, minimal chat panel for TradingView's retired public chat rooms, using your own logged-in session. Not affiliated with TradingView.
// @match        https://www.tradingview.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
/* ----------------------------------------------------------------------------
   Copyright (c) 2026. All rights reserved. See README.md.
   Unofficial. Not affiliated with, endorsed by or supported by TradingView.

   WHAT THIS IS
   TradingView removed the public-chat *page* on 2026-09-30 but (at the time of
   writing) left the server endpoints that page used still running. This script
   draws a small chat panel in the corner of any tradingview.com tab and talks
   to those same endpoints, authenticated by your normal login cookie. It is the
   old UI, rebuilt small -- not a scraper, not automation. Read-and-chat only.

   It reuses exactly the calls the old page made:
     - GET  /chats/public/get/        list public rooms
     - GET  /conversation-status/     load + poll messages for a room
     - POST /conversation-post/       send a message
   Public rooms use is_private="" (empty). That one detail matters.

   HOW TO INSTALL: see README.md (Tampermonkey, 2 minutes).
   -------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.__tvChatRevival) return;          // don't double-inject
  window.__tvChatRevival = true;

  // ---- tiny HTTP helpers (same-origin, cookies sent automatically) ----------
  const api = {
    async get(path, params) {
      const url = new URL(path, location.origin);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const r = await fetch(url.href, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
      return r.json();
    },
    async post(path, data) {
      const body = new URLSearchParams(data).toString();
      const r = await fetch(new URL(path, location.origin).href, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body
      });
      if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
      return r.json().catch(() => ({}));
    }
  };

  // ---- state ----------------------------------------------------------------
  let rooms = [];
  let roomId = null;
  let seen = new Set();     // message ids already shown (dedupe)
  let timer = null;
  let fails = 0;            // failed refreshes in a row; each one doubles the wait
  let sending = false;
  let newWhileAway = false; // a message arrived while you were scrolled up
  const MAX_SHOWN = 400;    // oldest messages drop off the screen past this

  // ---- UI --------------------------------------------------------------------
  const css = `
    #tvcr{position:fixed;right:16px;bottom:16px;width:340px;height:460px;z-index:2147483647;box-sizing:border-box;
      min-width:340px;min-height:170px;max-width:calc(100vw - 8px);max-height:calc(100vh - 8px);resize:both;overflow:hidden;
      display:flex;flex-direction:column;background:#131722;color:#d1d4dc;border:1px solid #2a2e39;
      border-radius:10px;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    #tvcr .hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a2e39;cursor:move;user-select:none}
    #tvcr .hd b{color:#fff;font-size:12px;flex:0 0 auto}
    #tvcr select{flex:1;background:#1c2030;color:#d1d4dc;border:1px solid #2a2e39;border-radius:6px;padding:4px}
    #tvcr .x{cursor:pointer;color:#787b86;padding:0 4px}
    #tvcr .logwrap{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}
    #tvcr .log{flex:1;min-height:0;overflow-y:auto;padding:8px 10px}
    #tvcr .log,#tvcr .log *{user-select:text!important;-webkit-user-select:text!important}
    #tvcr .log ::selection{background:#4f79c7;color:#fff}
    #tvcr .jump{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:2;border:0;border-radius:14px;
      padding:4px 12px;font-size:12px;cursor:pointer;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.5)}    #tvcr .m{margin:0 0 8px;display:flex;gap:8px;align-items:flex-start;border-radius:4px;position:relative}
    #tvcr .m.cont{margin-top:-6px}
    #tvcr .m.cont .mh{display:none}
    #tvcr .m.cont .avl{visibility:hidden;pointer-events:none}
    #tvcr .m.cont .av{height:0}
    #tvcr .m.ment{background:#2a2410;border-left:3px solid #ff9800;padding-left:5px}
    #tvcr .av{display:block;width:28px;height:28px;border-radius:50%;flex:0 0 auto;background:#2a2e39;object-fit:cover}
    #tvcr .mc{flex:1;min-width:0}
    #tvcr .mh{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
    #tvcr .mb{word-break:break-word}
    #tvcr .avl{flex:0 0 auto;display:block;line-height:0;border-radius:50%}
    #tvcr .avl:hover .av{outline:2px solid #2962ff}
    #tvcr .m .u{color:#2962ff;font-weight:600;cursor:pointer}
    #tvcr .m .u:hover{text-decoration:underline}
    #tvcr .m.mod .u{color:#ff9800}
    #tvcr .m.mine .u{color:#26a69a}
    #tvcr .bd{font-size:9px;padding:0 4px;border-radius:3px;background:#2a2e39;color:#d1d4dc;font-weight:700}
    #tvcr .bd.mod{background:#ff9800;color:#000}
    #tvcr .bd.pro{background:#2962ff;color:#fff}
    #tvcr .tm{color:#787b86;font-size:11px}
    #tvcr .men{color:#4da3ff;font-weight:600}
    #tvcr .men.me{background:#ff9800;color:#000;border-radius:3px;padding:0 3px}
    #tvcr .log.mo .m:not(.ment){display:none}
    #tvcr .log.mo .m.cont{margin-top:0}
    #tvcr .log.mo .m.cont .mh{display:flex}
    #tvcr .log.mo .m.cont .avl{visibility:visible;pointer-events:auto}
    #tvcr .log.mo .m.cont .av{height:28px}
    #tvcr .log.mo .m.cont .acts .ct{display:none}
    #tvcr .hd button.s.on{background:#ff9800;color:#000}
    #tvcr a.snap{display:block;margin-top:4px;width:fit-content;max-width:100%;text-decoration:none;color:#9ea3b0;font-size:12px}
    #tvcr .snapimg{display:block;height:160px;max-width:100%;object-fit:contain;border:1px solid #2a2e39;border-radius:6px;background:#0e111a}
    #tvcr a.snap:hover .snapimg{border-color:#2962ff}
    #tvcr .snapimg{cursor:zoom-in}
    #tvcr-lb{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.85);display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:10px;cursor:zoom-out}
    #tvcr-lb img{max-width:94vw;max-height:86vh;object-fit:contain;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.6)}
    #tvcr-lb a{color:#4da3ff;font:13px -apple-system,Segoe UI,Roboto,sans-serif}
    #tvcr a.snap.broken .snapimg{display:none}
    #tvcr a.snap.broken::after{content:"📈 chart snapshot (open)";text-decoration:underline}
    #tvcr .tip{padding:6px 10px;font-size:12px;color:#d1d4dc;background:#1c2030;border-top:1px solid #2a2e39}
    #tvcr .ft{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #2a2e39}
    #tvcr textarea.t{flex:1;resize:none;box-sizing:border-box;height:34px;min-height:34px;max-height:90px;font:inherit;background:#1c2030;color:#fff;border:1px solid #2a2e39;border-radius:6px;padding:6px 8px}
    #tvcr button.s{background:#2962ff;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
    #tvcr button.s.ic{display:flex;align-items:center;justify-content:center;padding:6px 8px}
    #tvcr button.s.ic svg{display:block}
    #tvcr button.s.ic:hover{filter:brightness(1.15)}
    #tvcr .st{padding:4px 10px;font-size:11px;color:#787b86;border-top:1px solid #2a2e39}
    #tvcr blockquote.q{margin:2px 0 4px;padding:3px 8px;border-left:3px solid #434651;background:#1c2030;border-radius:0 4px 4px 0;color:#9ea3b0}
    #tvcr .qw{font-size:11px;color:#787b86;font-weight:600}
    #tvcr .sy{margin-left:6px;padding:0 5px;border-radius:3px;background:#1c2030;border:1px solid #2a2e39;color:#9ea3b0;font-size:10px;text-decoration:none}
    #tvcr a.sy:hover{border-color:#2962ff;color:#fff}
    #tvcr .qb{color:#787b86;cursor:pointer;margin-left:6px;font-size:11px;visibility:hidden}
    #tvcr .m:hover .qb{visibility:visible}
    #tvcr .qb:hover{color:#fff}
    #tvcr .acts{position:absolute;top:-4px;right:2px;display:none;align-items:center;gap:8px;padding:1px 6px;
      background:#1c2030;border:1px solid #2a2e39;border-radius:4px;font-size:11px;color:#787b86}
    #tvcr .m:hover .acts,#tvcr .m.menu-open .acts{display:flex}
    #tvcr .acts .ct{display:none}
    #tvcr .m.cont .acts .ct{display:inline}
    #tvcr .dots{cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
    #tvcr .dots:hover{color:#fff}
    #tvcr-menu{position:absolute;z-index:4;min-width:130px;padding:4px;background:#1c2030;border:1px solid #2a2e39;
      border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    #tvcr-menu div{padding:5px 10px;border-radius:4px;cursor:pointer}
    #tvcr-menu div:hover{background:#2a2e39;color:#fff}
    #tvcr-menu div.danger:hover{background:#f23645;color:#fff}
    #tvcr-pk{position:absolute;left:8px;right:8px;bottom:84px;max-height:200px;overflow-y:auto;padding:6px;z-index:3;
      display:grid;grid-template-columns:repeat(8,1fr);gap:2px;background:#1c2030;border:1px solid #2a2e39;border-radius:8px}
    #tvcr-pk span{cursor:pointer;text-align:center;padding:3px;border-radius:4px;font-size:18px}
    #tvcr-pk span:hover{background:#2a2e39}
    #tvcr-set{position:absolute;top:44px;left:8px;right:8px;bottom:8px;z-index:5;overflow-y:auto;padding:10px;
      border:1px solid;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    #tvcr-set .sh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    #tvcr-set .row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:5px 0;
      border-bottom:1px solid var(--tv-border,#2a2e39)}
    #tvcr-set input[type=color]{width:42px;height:24px;padding:0;border:0;background:none;cursor:pointer}
    #tvcr-set select{flex:0 1 150px}
    #tvcr-set .size-actions{display:flex;gap:4px}
    #tvcr-set .size-actions button{background:var(--tv-surface,#1c2030);color:var(--tv-text,#d1d4dc);
      border:1px solid var(--tv-border,#2a2e39);border-radius:4px;padding:4px 6px;cursor:pointer;font:inherit;font-size:11px}
    #tvcr-set .size-actions button:hover{border-color:var(--tv-btn,#2962ff)}
    #tvcr-set input[type=range]:disabled{opacity:.4}
    #tvcr-set i{font-style:normal;opacity:.7;margin-left:6px}
    #tvcr-set button.s{margin-top:10px;width:100%}
    /* appearance settings (⚙): everything below reads the --tv-* values set from the panel */
    #tvcr{background:var(--tv-bg,#131722);color:var(--tv-text,#d1d4dc);border-color:var(--tv-border,#2a2e39);
      font-family:var(--tv-font,-apple-system,Segoe UI,Roboto,sans-serif)}
    #tvcr .log,#tvcr textarea.t{font-size:var(--tv-size,13px)}
    #tvcr .hd,#tvcr .ft,#tvcr .st,#tvcr .tip{border-color:var(--tv-border,#2a2e39)}
    #tvcr select,#tvcr textarea.t,#tvcr .tip,#tvcr blockquote.q,#tvcr .acts,#tvcr .sy,#tvcr-pk,#tvcr-menu,#tvcr-set{
      background:var(--tv-surface,#1c2030);border-color:var(--tv-border,#2a2e39)}
    #tvcr select,#tvcr textarea.t,#tvcr-set{color:var(--tv-text,#d1d4dc)}
    #tvcr button.s,#tvcr .jump{background:var(--tv-btn,#2962ff);color:var(--tv-btnText,#ffffff)}
    #tvcr .m .u{color:var(--tv-other,#2962ff)}
    #tvcr .m.mine .u{color:var(--tv-me,#26a69a)}
    #tvcr .m.mod .u{color:#ff9800}
    #tvcr .m.ment{border-left-color:var(--tv-mention,#ff9800)}
    #tvcr .men.me{background:var(--tv-mention,#ff9800)}
    #tvcr.glow-names .m .u{text-shadow:0 0 var(--tv-glow-near,6px) currentColor,0 0 var(--tv-glow-far,14px) currentColor}
    #tvcr .hd button.s.on{background:var(--tv-mention,#ff9800);color:#000}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'tvcr';
  el.innerHTML = `
    <div class="hd"><b>TV Chat</b><select id="tvcr-room"></select><button class="s" id="tvcr-mo" title="Show only messages that mention you (click again for all)" style="padding:2px 8px">@me</button><button class="s" id="tvcr-gear" title="Appearance: text size, font, colours" style="padding:2px 8px">⚙</button><span class="x" id="tvcr-close" title="close">✕</span></div>
    <div class="logwrap"><div class="log" id="tvcr-log"></div><button class="jump" id="tvcr-jump" style="display:none">↓ Jump to present</button></div>
    <div id="tvcr-set" style="display:none"></div>
    <div id="tvcr-menu" style="display:none"></div>
    <div id="tvcr-pk" style="display:none"></div>
    <div class="tip" id="tvcr-tip" style="display:none"></div>
    <div class="ft"><button class="s ic" id="tvcr-emo" title="Emoji"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2"/><circle cx="9" cy="10" r=".7" fill="currentColor"/><circle cx="15" cy="10" r=".7" fill="currentColor"/></svg></button><button class="s ic" id="tvcr-snap" title="Share a chart snapshot"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.3" r="3.6"/></svg></button><textarea class="t" id="tvcr-in" rows="1" placeholder="Message…"></textarea><button class="s" id="tvcr-send">Send</button></div>
    <div class="st" id="tvcr-st">starting…</div>`;
  document.body.appendChild(el);

  const $ = id => document.getElementById(id);
  // esc() is for TEXT between tags. It leaves ' alone on purpose: the smiley
  // matcher runs on escaped text and needs to see :'( as typed.
  const esc = s => (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // attr() is for anything inside an attribute (title="..."), where a quote
  // mark in a name would otherwise end the attribute early.
  const attr = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = t => { $('tvcr-st').textContent = t; };

  // --- quotes -----------------------------------------------------------------
  // The old chat sent a quote as plain text: [quote="name"]message[/quote]
  // and drew it as a box. Everything here is escaped before it reaches the page.
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#039': "'", '#39': "'", '#x27': "'" };
  const decode = s => String(s == null ? '' : s).replace(/&(amp|lt|gt|quot|apos|#0?39|#x27);/g, (m, e) => ENT[e]);

  // --- emoji ------------------------------------------------------------------
  // The old chat's emoji were typed as :codes:. We send the code (so people on
  // the old UI see the TradingView picture) and show an ordinary emoji here.
  const UNI = {
    ':agree:': '👍', ':disagree:': '👎', ':okay:': '👌', ':peace:': '✌️', ':wait:': '✋', ':wave:': '👋',
    ':raised_hands:': '🙌', ':pray:': '🙏', ':joy:': '😂', ':love:': '😍', ':flushed:': '😳',
    ':thinking_face:': '🤔', ':weary:': '😩', ':cry:': '😢', ':panic:': '😱', ':rage:': '😡',
    ':triumph:': '😤', ':mask:': '😷', ':shades:': '😎', ':sleepy:': '😪', ':halo:': '😇',
    ':sarcasm:': '🙄', ':money_mouth:': '🤑', ':zzz:': '💤', ':buy:': '⬆️', ':sell:': '⬇️',
    ':profit:': '💰', ':loss:': '💸', ':uptrend:': '📈', ':downtrend:': '📉', ':bear:': '🐻',
    ':bull:': '🐂', ':dollar:': '💵', ':euro:': '💶', ':pound:': '💷', ':yen:': '💴',
    ':bitcoin:': '₿', ':ethereum:': 'Ξ', ':moneybag:': '💰', ':cookie:': '🍪', ':coffee:': '☕',
    ':popcorn:': '🍿', ':cocktail:': '🍸', ':hot:': '🔥', ':poop:': '💩', ':heart:': '❤️',
    ':heartbroken:': '💔', ':sun:': '☀️', ':moon:': '🌙', ':sunflower:': '🌻', ':star:': '⭐',
    ':sunny:': '🌞', ':partly_sunny:': '⛅', ':cloud:': '☁️', ':zap:': '⚡', ':hammer:': '🔨',
    ':idea:': '💡', ':slot_machine:': '🎰', ':bullseye:': '🎯', ':rocket:': '🚀',
    ':inverted_rocket:': '🚀', ':checkered_flag:': '🏁', ':alarm_clock:': '⏰', ':rip:': '🪦',
    ':ghost:': '👻', ':up:': '🆙', ':cool:': '🆒', ':free:': '🆓', ':sos:': '🆘', ':100:': '💯',
    ':stop:': '🛑', ':credit_card:': '💳', ':new:': '🆕', ':ok:': '🆗', ':tip:': '🪙'
  };
  // takes ALREADY-ESCAPED text; codes contain only a-z 0-9 _ and : so this is safe
  const emo = s => s.replace(/:[a-z0-9_]{2,24}:/g, c => !UNI[c] ? c
    : '<span title="' + c + '"' + (c === ':inverted_rocket:' ? ' style="display:inline-block;transform:scaleY(-1)"' : '') + '>' + UNI[c] + '</span>');

  // --- smileys, @mentions, and the text pipeline --------------------------------
  // Order matters: escape first, so nothing a person types can become markup,
  // then wrap @mentions, then smileys, then :emoji: codes.
  const myName = () => { try { return (window.user && window.user.username) || ''; } catch (e) { return ''; } };
  const SMILEY = { ':)': '🙂', ';)': '😉', ':|': '😐', ':(': '🙁', ":'(": '😢', ':D': '😃', ':P': '😛', ']:-)': '😈' };
  const SMILEY_RE = /(?<![A-Za-z0-9])(?:\]:-\)|:'\(|:\)|;\)|:\||:\(|:D|:P)(?![A-Za-z0-9])/g;
  const rich = raw => {
    const me = myName().toLowerCase();
    let s = esc(raw).replace(/@[A-Za-z0-9_]{2,32}/g,
      t => '<span class="men' + (me && t.slice(1).toLowerCase() === me ? ' me' : '') + '">' + t + '</span>');
    s = s.replace(SMILEY_RE, t => '<span title="' + t + '">' + SMILEY[t] + '</span>');
    return emo(s);
  };

  function parseQuotes(raw) {
    const root = { kids: [] };
    const stack = [root];
    const re = /\[quote="([^"\]\n]{0,60})"\]|\[\/quote\]/g;
    let last = 0, m;
    while ((m = re.exec(raw))) {
      const cur = stack[stack.length - 1];
      if (m.index > last) cur.kids.push({ text: raw.slice(last, m.index) });
      if (m[0] === '[/quote]') {
        if (stack.length > 1) stack.pop(); else cur.kids.push({ text: m[0] });
      } else {
        const q = { who: m[1], kids: [] };
        cur.kids.push(q);
        stack.push(q);
      }
      last = re.lastIndex;
    }
    if (last < raw.length) stack[stack.length - 1].kids.push({ text: raw.slice(last) });
    return root.kids;
  }
  // a quote inside a quote is dropped, as the old chat did
  function renderKids(kids, depth) {
    return kids.map(k => {
      if (k.who !== undefined) {
        if (depth >= 1) return '';
        return '<blockquote class="q"><div class="qw">' + esc(k.who) + ' wrote:</div>' + renderKids(k.kids, depth + 1) + '</blockquote>';
      }
      const t = k.text.replace(/^\n+|\n+$/g, '');
      return t ? '<span>' + rich(t).replace(/\n/g, '<br>') + '</span>' : '';
    }).join('');
  }
  function stripQuotes(s) {
    const re = /\[quote="[^"\]\n]*"\](?:(?!\[quote=)[\s\S])*?\[\/quote\]/g;
    let prev;
    do { prev = s; s = s.replace(re, ''); } while (s !== prev);
    return s.trim();
  }

  // --- which chart are you / they on -------------------------------------------
  // The old chat sent the chart's symbol with every message, and the timeframe
  // inside "meta". Only on a chart page, as before. First choice is the chart's
  // own API; the fallback reads the page title ("BTCUSD 84,486 ...") and the
  // highlighted timeframe button.
  function chartInfo() {
    if (!/^\/chart\//.test(location.pathname)) return { symbol: '', interval: '' };
    try {
      const c = window.TradingViewApi && window.TradingViewApi.activeChart();
      if (c) return { symbol: String(c.symbol() || ''), interval: String(c.resolution() || '') };
    } catch (e) { /* fall through to the page itself */ }
    const t = document.querySelector('#header-toolbar-intervals [aria-checked="true"]');
    return { symbol: (document.title.split(/\s+/)[0] || ''), interval: t ? t.textContent.trim() : '' };
  }
  function fmtInterval(v) {
    v = String(v);
    if (/^\d+$/.test(v)) { const n = +v; return n < 60 ? n + 'm' : (n % 60 === 0 && n < 1440 ? n / 60 + 'h' : v); }
    return v === '1D' ? 'D' : v === '1W' ? 'W' : v === '1M' ? 'M' : v;
  }
  function chartTag(m) {
    let meta = m.meta;
    try { if (typeof meta === 'string') meta = JSON.parse(meta); } catch (e) { meta = null; }
    const sym = decode(m.symbol || (meta && meta.symbol) || '').trim();
    if (!sym) return '';
    const ivRaw = (meta && meta.interval) || m.interval;
    const iv = ivRaw ? ' · ' + fmtInterval(ivRaw) : '';
    const label = esc(sym.split(':').pop()) + esc(iv);
    return /^[A-Za-z0-9:._!-]{1,40}$/.test(sym)
      ? `<a class="sy" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}" target="_blank" rel="noopener noreferrer" title="Open ${attr(sym)}">${label}</a>`
      : `<span class="sy">${label}</span>`;
  }

  // --- chart snapshots ---------------------------------------------------------
  // TradingView's own snapshot links look like tradingview.com/x/AbCd1234/, and
  // the picture lives at s3.tradingview.com/snapshots/<first letter, lower>/<id>.png.
  // The old chat sent a share as meta.type "snapshot" with meta.url; a link
  // typed or pasted into the text is shown the same way. Ids are letters and
  // digits only, so they go into the markup without escaping.
  const SNAP_RE = /https?:\/\/(?:[a-z]{2,3}\.)?tradingview\.com\/x\/([A-Za-z0-9]{6,16})\/?/g;
  function snapIds(m, text) {
    const ids = [];
    let meta = m.meta;
    try { if (typeof meta === 'string') meta = JSON.parse(meta); } catch (e) { meta = null; }
    const add = s => {
      let x;
      SNAP_RE.lastIndex = 0;
      while ((x = SNAP_RE.exec(String(s || '')))) if (!ids.includes(x[1])) ids.push(x[1]);
    };
    if (meta && meta.type === 'snapshot') add(meta.url);
    add(text);
    return ids.slice(0, 3);
  }
  const snapsHTML = (m, text) => snapIds(m, text).map(id =>
    '<a class="snap" href="https://www.tradingview.com/x/' + id + '/" target="_blank" rel="noopener noreferrer" title="Open chart snapshot">' +
    '<img class="snapimg" alt="chart snapshot" loading="lazy" referrerpolicy="no-referrer" src="https://s3.tradingview.com/snapshots/' +
    id[0].toLowerCase() + '/' + id + '.png"></a>').join('');

  // The server's time looks like "Fri Oct  2 23:09:22 2026 UTC"; read it by hand
  // so it does not depend on how the browser guesses at that format.
  function parseTime(s) {
    const x = /^[A-Za-z]{3} ([A-Za-z]{3})\s+(\d+) (\d+):(\d+):(\d+) (\d{4}) UTC$/.exec(String(s || '').trim());
    if (x) {
      const mo = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(x[1]) / 3;
      if (mo >= 0 && mo % 1 === 0) return Date.UTC(+x[6], mo, +x[2], +x[3], +x[4], +x[5]);
    }
    return Date.parse(s);
  }
  // badges come as [{name:"pro:pro", verbose_name:"Essential"}]; moderators are a flag
  function badgesHTML(m) {
    let out = m.is_moderator ? '<span class="bd mod">MOD</span>' : '';
    (Array.isArray(m.badges) ? m.badges : []).forEach(b => {
      const label = (b && (b.verbose_name || b.name)) || '';
      if (label) out += '<span class="bd' + (/^pro:/.test((b && b.name) || '') ? ' pro' : '') + '">' + esc(label) + '</span>';
    });
    return out;
  }
  // only draw a picture if the link is a plain tradingview.com address
  const AV_OK = /^https:\/\/[a-z0-9.-]+\.tradingview\.com\/[A-Za-z0-9_\/.\-]+$/;

  const myId = () => { try { return (window.user && window.user.id) || null; } catch (e) { return null; } };

  function addMsg(m) {
    if (m.deleted || m.is_deleted) return;
    if (m.id != null) { if (seen.has(m.id)) return; seen.add(m.id); }
    const user = m.username || '';
    const me = myName();
    const mine = (!!me && user.toLowerCase() === me.toLowerCase()) ||
      (myId() != null && m.user_id != null && String(m.user_id) === String(myId()));
    const raw = decode(m.text);
    const mention = !!me && !mine &&
      new RegExp('(^|[^A-Za-z0-9_])@' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])', 'i').test(stripQuotes(raw));
    const ts = parseTime(m.time);
    const tm = isNaN(ts) ? '' : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const tmTitle = isNaN(ts) ? '' : new Date(ts).toLocaleString();
    const pic = AV_OK.test(m.user_pic || '')
      ? `<img class="av" src="${m.user_pic}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : '<span class="av"></span>';
    // the picture opens their public TradingView profile in a new tab
    const av = user
      ? `<a class="avl" href="https://www.tradingview.com/u/${encodeURIComponent(user)}/" target="_blank" rel="noopener noreferrer" title="Open ${attr(user)}&#39;s profile">${pic}</a>`
      : pic;
    const d = document.createElement('div');
    d.className = 'm' + (m.is_moderator ? ' mod' : '') + (mention ? ' ment' : '') + (mine ? ' mine' : '');
    d.dataset.user = user;
    if (m.id != null) d.dataset.id = String(m.id);
    d.dataset.ts = String(ts);
    d._raw = raw;
    d._mine = mine && m.id != null;
    // Header: name, then quote, then badges / chart / time. The hover bar on the
    // right holds the ⋮ menu; on a follow-on message (header hidden) it also
    // carries that message's time and its quote button.
    d.innerHTML = av + '<div class="mc"><div class="mh"><span class="u">' + esc(user) + '</span>' +
      '<span class="qb" title="Quote this message">❝ quote</span>' +
      badgesHTML(m) + chartTag(m) +
      '<span class="tm" title="' + attr(tmTitle) + '">' + esc(tm) + '</span></div>' +
      '<div class="mb">' + renderKids(parseQuotes(raw), 0) + snapsHTML(m, stripQuotes(raw)) + '</div></div>' +
      '<div class="acts"><span class="tm ct" title="' + attr(tmTitle) + '">' + esc(tm) + '</span>' +
      '<span class="qb ct" title="Quote this message">❝</span>' +
      '<span class="dots" title="More">⋮</span></div>';
    // if a picture can't load, keep a plain link to the snapshot instead
    d.querySelectorAll('img.snapimg').forEach(i => i.addEventListener('error', () => i.parentNode.classList.add('broken')));
    const log = $('tvcr-log');
    const atBottom = log.scrollTop + log.clientHeight > log.scrollHeight - 30;
    log.appendChild(d);
    // back-to-back messages from the same person show one name and picture
    const prev = d.previousElementSibling;
    d.classList.toggle('cont', !!prev && !!user && prev.dataset.user === user);
    // keep the screen to the newest MAX_SHOWN; the new top one gets its name back
    if (log.children.length > MAX_SHOWN) {
      while (log.children.length > MAX_SHOWN) log.removeChild(log.firstElementChild);
      log.firstElementChild.classList.remove('cont');
    }
    if (seen.size > 3000) {                      // forget the oldest ids too
      const it = seen.values();
      for (let i = 0; i < 1000; i++) seen.delete(it.next().value);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
    else newWhileAway = true;
  }

  // Every load waits for the one before it, so a refresh, a send and a delete
  // can never race each other (a delete used to check the room while a regular
  // refresh was still landing, and could report a false failure).
  let inflight = Promise.resolve();
  function loadMessages(initial) {
    const run = inflight.then(() => loadNow(initial));
    inflight = run.catch(() => {});
    return run;
  }

  async function loadNow(initial) {
    if (!roomId) return;
    try {
      const data = await api.get('/conversation-status/', {
        _rand: Math.random(), offset: 0, room: roomId, room_id: roomId,
        stat_interval: '', stat_symbol: '', is_private: ''
      });
      let msgs = data.messages || [];
      // the server sends newest first; the panel reads oldest first
      const tm = x => parseTime(x && x.time);
      if (msgs.length > 1) {
        const a = tm(msgs[0]), b = tm(msgs[msgs.length - 1]);
        if (isNaN(a) || isNaN(b) || a >= b) msgs = msgs.slice().reverse();
      }
      if (initial) { $('tvcr-log').innerHTML = ''; seen = new Set(); }
      msgs.forEach(addMsg);
      // A message that was in the server's recent window and has dropped out
      // of it, while newer and older ones are still there, was deleted (by
      // its author or a moderator), so take it off the screen too.
      if (!initial && msgs.length) {
        const ids = new Set(msgs.map(x => String(x.id)));
        const oldest = Math.min(...msgs.map(x => parseTime(x.time)).filter(t => !isNaN(t)));
        $('tvcr-log').querySelectorAll('.m[data-id]').forEach(n => {
          if (+n.dataset.ts >= oldest && !ids.has(n.dataset.id)) n.remove();
        });
        regroup();
      }
      updateJump();
      fails = 0;
      status('connected · ' + new Date().toLocaleTimeString());
    } catch (e) {
      fails++;
      status('refresh failed: ' + e.message + (fails > 1 ? ' · retrying more slowly' : ''));
    }
  }

  // Refresh every 3s while you're looking, every 15s while the tab is hidden,
  // and twice as slowly after each failure in a row (capped at a minute), so a
  // TradingView hiccup doesn't get hammered. One timer at a time.
  function schedule() {
    clearTimeout(timer);
    const base = document.hidden ? 15000 : 3000;
    timer = setTimeout(async () => { await loadMessages(false); schedule(); }, Math.min(base * 2 ** fails, 60000));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && roomId) { clearTimeout(timer); loadMessages(false).then(schedule); }
  });

  // after a message disappears, the one below may need its name back
  function regroup() {
    let prev = null;
    $('tvcr-log').querySelectorAll('.m').forEach(n => {
      n.classList.toggle('cont', !!prev && !!n.dataset.user && prev.dataset.user === n.dataset.user);
      prev = n;
    });
  }

  async function selectRoom(id) {
    roomId = id;
    try { localStorage.setItem('tvcr.room', String(id)); } catch (e) { /* storage blocked */ }
    clearTimeout(timer);
    fails = 0;
    await loadMessages(true);
    schedule();
  }

  // the message box grows with what you type, up to its max-height
  function grow() {
    const inp = $('tvcr-in');
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight + 2, 90) + 'px';
  }

  async function send() {
    const inp = $('tvcr-in'); const text = inp.value.trim();
    if (!text || !roomId || sending) return;
    sending = true;
    inp.value = '';
    grow();
    try {
      const ci = chartInfo();   // same as the old chat: symbol + timeframe go with the message
      await api.post('/conversation-post/', {
        room_id: roomId, text, symbol: ci.symbol, is_private: '', meta: JSON.stringify({ interval: ci.interval })
      });
      status('sent · refreshing…');
      loadMessages(false);
    } catch (e) {
      status('send failed: ' + e.message + ' (you may need to be logged in)');
      inp.value = text;
      grow();
    } finally { sending = false; }
  }

  async function init() {
    try {
      status('loading rooms…');
      const data = await api.get('/chats/public/get/');
      rooms = data.rooms || data.list || (Array.isArray(data) ? data : []);
      const sel = $('tvcr-room');
      sel.innerHTML = '';
      rooms.forEach(r => {
        const o = document.createElement('option');
        o.value = r.room_id || r.id;
        o.textContent = r.title || r.name || ('room ' + (r.room_id || r.id));
        sel.appendChild(o);
      });
      if (!rooms.length) { status('no public rooms returned — backend may be shut off'); return; }
      // reopen the room you were in, on any TradingView page, if it still exists
      let saved = null;
      try { saved = localStorage.getItem('tvcr.room'); } catch (e) { /* storage blocked */ }
      if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
      sel.onchange = () => selectRoom(sel.value);
      await selectRoom(sel.value);
    } catch (e) { status('could not load rooms: ' + e.message); }
  }

  // "❝ quote" appears when you hover a message: it puts the old chat's quote
  // format into the box, and the person you quote sees it as a quote box.
  $('tvcr-log').addEventListener('click', e => {
    const b = e.target.closest('.qb');
    if (!b) return;
    const msg = b.closest('.m');
    const inp = $('tvcr-in');
    const cur = inp.value.trim();
    inp.value = (cur ? cur + '\n' : '') + '[quote="' + String(msg.dataset.user).replace(/\s/g, ' ') + '"]' + stripQuotes(msg._raw) + '[/quote]\n';
    inp.focus();
    grow();
  });

  // emoji picker: click the 😀 button, click an emoji, its :code: goes in the box
  const pk = $('tvcr-pk');
  pk.innerHTML = Object.keys(UNI).map(c => '<span data-c="' + c + '" title="' + c + '">' + UNI[c] + '</span>').join('');
  $('tvcr-emo').onclick = () => { pk.style.display = pk.style.display === 'none' ? 'grid' : 'none'; };
  pk.addEventListener('click', e => {
    const s = e.target.closest('[data-c]');
    if (!s) return;
    const inp = $('tvcr-in');
    const a = inp.selectionStart, b = inp.selectionEnd;
    inp.value = inp.value.slice(0, a) + s.dataset.c + ' ' + inp.value.slice(b);
    inp.selectionStart = inp.selectionEnd = a + s.dataset.c.length + 1;
    pk.style.display = 'none';
    inp.focus();
    grow();
  });
  // the picker closes when you click anywhere else
  document.addEventListener('click', e => {
    if (pk.style.display !== 'none' && !e.target.closest('#tvcr-pk, #tvcr-emo')) pk.style.display = 'none';
  });

  // drag the panel by its title bar; it remembers where you left it
  function place(x, y) {
    el.style.right = el.style.bottom = 'auto';
    el.style.left = Math.max(0, Math.min(x, innerWidth - 80)) + 'px';
    el.style.top = Math.max(0, Math.min(y, innerHeight - 40)) + 'px';
  }
  // Stretch it from the bottom-right corner; the shorter minimum height also
  // allows a two-message panel. Both manual and preset sizes are remembered.
  try {
    const s = JSON.parse(localStorage.getItem('tvcr.size'));
    if (s && s.w && s.h) { el.style.width = s.w + 'px'; el.style.height = s.h + 'px'; }
  } catch (err) { /* no saved size */ }
  function setPanelSize(w, h) {
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    place(Math.min(el.offsetLeft, Math.max(0, innerWidth - el.offsetWidth - 8)),
      Math.min(el.offsetTop, Math.max(0, innerHeight - el.offsetHeight - 8)));
    try { localStorage.setItem('tvcr.size', JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight })); }
    catch (err) { /* storage blocked */ }
    try { localStorage.setItem('tvcr.pos', JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); }
    catch (err) { /* storage blocked */ }
  }
  let savedPos = null;
  try { savedPos = JSON.parse(localStorage.getItem('tvcr.pos')); } catch (err) { /* no saved spot */ }
  if (savedPos) place(savedPos.x, savedPos.y);
  else { const r0 = el.getBoundingClientRect(); place(r0.left, r0.top); }   // pinned by its top-left, so stretching grows right and down
  if (window.ResizeObserver) {
    let t = null;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        try { localStorage.setItem('tvcr.size', JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight })); } catch (err) { /* storage blocked */ }
      }, 300);
    }).observe(el);
  }
  el.querySelector('.hd').addEventListener('mousedown', e => {
    if (e.target.closest('button,select,.x')) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('tvcr.pos', JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); } catch (err) { /* storage blocked */ }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  window.addEventListener('resize', () => { if (el.style.left) place(el.offsetLeft, el.offsetTop); });

  // 🗑 on your own message: the old chat posted ids to /conversation-delete/.
  // The exact form it sent them in isn't known, so try both ways a form can
  // carry a list, and after each one reload the room to see whether the
  // message really went. It only reports success if the server dropped it.
  async function deleteMine(msgEl) {
    const id = msgEl.dataset.id;
    if (!id || !confirm('Delete this message for everyone?')) return;
    for (const body of [{ 'ids[]': id }, { ids: id }]) {
      try { await api.post('/conversation-delete/', body); } catch (e) { continue; }
      await loadMessages(true);
      const still = [...$('tvcr-log').querySelectorAll('.m[data-id]')].some(n => n.dataset.id === id);
      if (!still) { tip('Message deleted.'); return; }
    }
    tip('Could not delete that message: the server still has it.');
  }
  // ⋮ on a message opens a small menu: Copy text, and Delete on your own.
  const menu = $('tvcr-menu');
  function closeMenu() {
    menu.style.display = 'none';
    const open = $('tvcr-log').querySelector('.m.menu-open');
    if (open) open.classList.remove('menu-open');
    menu._msg = null;
  }
  $('tvcr-log').addEventListener('click', e => {
    const dots = e.target.closest('.dots');
    if (!dots) return;
    e.stopPropagation();
    const msg = dots.closest('.m');
    if (menu._msg === msg) { closeMenu(); return; }
    closeMenu();
    menu._msg = msg;
    msg.classList.add('menu-open');
    menu.innerHTML = '<div data-act="copy">Copy text</div>' +
      (msg._mine ? '<div data-act="delete" class="danger">Delete</div>' : '');
    menu.style.display = 'block';
    // place it under the dots, kept inside the panel
    const pr = el.getBoundingClientRect(), dr = dots.getBoundingClientRect();
    const left = Math.max(4, Math.min(dr.right - pr.left - menu.offsetWidth, el.clientWidth - menu.offsetWidth - 4));
    let top = dr.bottom - pr.top + 4;
    if (top + menu.offsetHeight > el.clientHeight - 4) top = dr.top - pr.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px';
    menu.style.top = Math.max(4, top) + 'px';
  });
  menu.addEventListener('click', async e => {
    const it = e.target.closest('[data-act]');
    if (!it) return;
    const msg = menu._msg;
    closeMenu();
    if (!msg) return;
    if (it.dataset.act === 'copy') {
      try { await navigator.clipboard.writeText(msg._raw || ''); tip('Message copied.'); }
      catch (err) { tip('Could not copy: the browser blocked it.'); }
    } else if (it.dataset.act === 'delete') {
      deleteMine(msg);
    }
  });
  document.addEventListener('click', e => {
    if (menu.style.display !== 'none' && !e.target.closest('#tvcr-menu')) closeMenu();
  });
  // Esc closes whatever is open: the ⋮ menu, the emoji picker, the settings
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (menu.style.display !== 'none') closeMenu();
    pk.style.display = 'none';
    setEl.style.display = 'none';
  });

  // click a snapshot to see it large over the page; click anywhere or press
  // Esc to close. "Open on TradingView" still opens the full snapshot page.
  function lightbox(src, href) {
    const lb = document.createElement('div');
    lb.id = 'tvcr-lb';
    lb.innerHTML = '<img alt="chart snapshot"><a target="_blank" rel="noopener noreferrer">Open on TradingView ↗</a>';
    lb.querySelector('img').src = src;
    lb.querySelector('a').href = href;
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => { lb.remove(); document.removeEventListener('keydown', esc, true); };
    lb.addEventListener('click', e => { if (!e.target.closest('a')) close(); });
    document.addEventListener('keydown', esc, true);
    document.body.appendChild(lb);
  }
  $('tvcr-log').addEventListener('click', e => {
    const a = e.target.closest('a.snap');
    if (!a || a.classList.contains('broken')) return;
    e.preventDefault();
    lightbox(a.querySelector('img').src, a.href);
  });

  // a short note above the message box, gone after a few seconds
  function tip(t) {
    const e = $('tvcr-tip');
    e.textContent = t;
    e.style.display = 'block';
    clearTimeout(tip.timer);
    tip.timer = setTimeout(() => { e.style.display = 'none'; }, 10000);
  }

  // put text into the message box where the cursor is
  function insertAtCursor(s) {
    const inp = $('tvcr-in');
    const a = inp.selectionStart, b = inp.selectionEnd;
    inp.value = inp.value.slice(0, a) + s + inp.value.slice(b);
    inp.selectionStart = inp.selectionEnd = a + s.length;
    inp.focus();
    grow();
  }

  // click a name to @mention them
  $('tvcr-log').addEventListener('click', e => {
    const u = e.target.closest('.u');
    if (!u) return;
    if (window.getSelection() && !window.getSelection().isCollapsed) return;
    const name = u.closest('.m').dataset.user;
    if (name) insertAtCursor('@' + name + ' ');
  });

  // 📷: one click shares the chart in view. TradingView makes the snapshot
  // itself (Alt+S on a chart copies a link to the chart image), so the button
  // presses Alt+S for you, waits for a NEW snapshot link to land on the
  // clipboard, and puts it in the message box. Chrome asks once for clipboard
  // permission. If any step doesn't happen, it says what to do by hand.
  const snapLink = s => {
    SNAP_RE.lastIndex = 0;
    const x = SNAP_RE.exec(String(s || ''));
    return x ? 'https://www.tradingview.com/x/' + x[1] + '/' : '';
  };
  const readClip = async () => { try { return await navigator.clipboard.readText(); } catch (e) { return null; } };
  function pressAltS() {
    const opts = { key: 's', code: 'KeyS', keyCode: 83, which: 83, altKey: true, bubbles: true, cancelable: true, composed: true };
    const target = document.querySelector('.chart-container') || document.body;
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, opts);
      // older key handlers read keyCode/which, which the constructor can leave at 0
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => 83 });
        Object.defineProperty(ev, 'which', { get: () => 83 });
      } catch (e) { /* fine without */ }
      target.dispatchEvent(ev);
    }
  }
  let snapping = false;
  $('tvcr-snap').onclick = async () => {
    if (snapping) return;
    if (!/^\/chart\//.test(location.pathname)) { tip('Open a chart first: the camera button snapshots the chart on this page.'); return; }
    snapping = true;
    try {
      const before = await readClip();
      if (before === null) {
        tip('Chrome blocked clipboard access. Allow it for tradingview.com (the clipboard icon in the address bar), then click the camera button again.');
        return;
      }
      tip('Taking a snapshot…');
      pressAltS();
      const until = Date.now() + 10000;            // a wall-clock deadline, not a count
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 400));
        const now = await readClip();
        const link = snapLink(now);
        if (link && now !== before) {
          insertAtCursor(($('tvcr-in').value.trim() ? ' ' : '') + link + ' ');
          tip('Chart snapshot added. Press Enter to share it.');
          return;
        }
      }
      tip('No snapshot arrived. Press Alt+S on the chart yourself, then paste the link here with Ctrl+V.');
    } finally { snapping = false; }
  };

  // "@me" in the header: show only messages that mention you; click again for all
  $('tvcr-mo').onclick = () => {
    const on = $('tvcr-log').classList.toggle('mo');
    $('tvcr-mo').classList.toggle('on', on);
    tip(on ? 'Showing only messages that mention you. Click @me again to see everything.' : 'Showing all messages.');
  };

  // "Jump to present": appears when you've scrolled up, and says so if new
  // messages came in meanwhile.
  const jump = $('tvcr-jump');
  function updateJump() {
    const lg = $('tvcr-log');
    const away = lg.scrollHeight - lg.scrollTop - lg.clientHeight > 120;
    if (!away) newWhileAway = false;
    jump.textContent = newWhileAway ? '↓ New messages · Jump to present' : '↓ Jump to present';
    jump.style.display = away ? 'block' : 'none';
  }
  $('tvcr-log').addEventListener('scroll', updateJump);
  jump.onclick = () => { const lg = $('tvcr-log'); lg.scrollTop = lg.scrollHeight; updateJump(); };

  // ---- appearance settings (⚙) ----------------------------------------------
  // Saved in this browser only. Moderator names stay orange whatever you pick.
  const FONTS = {
    system: ['System default', '-apple-system,Segoe UI,Roboto,sans-serif'],
    arial: ['Arial', 'Arial,Helvetica,sans-serif'],
    verdana: ['Verdana', 'Verdana,Geneva,sans-serif'],
    trebuchet: ['Trebuchet', '"Trebuchet MS",sans-serif'],
    tahoma: ['Tahoma', 'Tahoma,Geneva,sans-serif'],
    georgia: ['Georgia', 'Georgia,serif'],
    mono: ['Monospace', 'Consolas,"Courier New",monospace'],
    comic: ['Comic Sans', '"Comic Sans MS","Comic Sans",cursive']
  };
  const THEME_DEFAULTS = {
    bg: '#131722', surface: '#1c2030', border: '#2a2e39', text: '#d1d4dc', btn: '#2962ff',
    btnText: '#ffffff', me: '#26a69a', other: '#2962ff', mention: '#ff9800', font: 'system', size: 13,
    glow: false, glowIntensity: 2
  };
  const COLOR_FIELDS = [
    ['bg', 'Background'], ['surface', 'Boxes and inputs'], ['border', 'Borders'], ['text', 'Text'],
    ['btn', 'Buttons'], ['btnText', 'Button text'], ['me', 'Your name'], ['other', "Other people's names"],
    ['mention', '@mention highlight']
  ];
  let theme = Object.assign({}, THEME_DEFAULTS);
  try { Object.assign(theme, JSON.parse(localStorage.getItem('tvcr.theme')) || {}); } catch (err) { /* nothing saved */ }
  function applyTheme() {
    COLOR_FIELDS.forEach(([k]) => el.style.setProperty('--tv-' + k, theme[k]));
    el.style.setProperty('--tv-font', (FONTS[theme.font] || FONTS.system)[1]);
    el.style.setProperty('--tv-size', (+theme.size || 13) + 'px');
    const glow = Math.max(1, Math.min(5, +theme.glowIntensity || 2));
    el.style.setProperty('--tv-glow-near', (glow * 2) + 'px');
    el.style.setProperty('--tv-glow-far', (glow * 4 + 2) + 'px');
    el.classList.toggle('glow-names', theme.glow === true);
  }
  function saveTheme() { try { localStorage.setItem('tvcr.theme', JSON.stringify(theme)); } catch (err) { /* storage blocked */ } }
  applyTheme();

  const setEl = $('tvcr-set');
  function buildSettings() {
    const fonts = Object.keys(FONTS).map(k =>
      '<option value="' + k + '"' + (theme.font === k ? ' selected' : '') + '>' + FONTS[k][0] + '</option>').join('');
    setEl.innerHTML =
      '<div class="sh"><b>Appearance</b><span class="x" data-close title="close">✕</span></div>' +
      '<label class="row"><span>Text size<i id="tvcr-sz">' + theme.size + 'px</i></span>' +
      '<input type="range" min="11" max="20" step="1" data-k="size" value="' + theme.size + '"></label>' +
      '<label class="row"><span>Font</span><select data-k="font">' + fonts + '</select></label>' +
      '<div class="row"><span>Panel size</span><span class="size-actions">' +
      '<button type="button" data-panel-size="compact" title="Short, wide panel showing about two messages">Two messages</button>' +
      '<button type="button" data-panel-size="regular">Regular</button></span></div>' +
      '<label class="row"><span>Username glow</span><input type="checkbox" data-k="glow"' +
      (theme.glow ? ' checked' : '') + '></label>' +
      '<label class="row"><span>Glow intensity<i id="tvcr-glow-level">' + theme.glowIntensity + '</i></span>' +
      '<input type="range" min="1" max="5" step="1" data-k="glowIntensity" value="' +
      theme.glowIntensity + '"' + (theme.glow ? '' : ' disabled') + '></label>' +
      COLOR_FIELDS.map(([k, label]) =>
        '<label class="row"><span>' + label + '</span><input type="color" data-k="' + k + '" value="' + theme[k] + '"></label>').join('') +
      '<button class="s" data-reset>Reset to default</button>';
  }
  setEl.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    theme[k] = k === 'glow' ? e.target.checked :
      (k === 'size' || k === 'glowIntensity' ? +e.target.value : e.target.value);
    if (k === 'size') $('tvcr-sz').textContent = theme.size + 'px';
    if (k === 'glowIntensity') $('tvcr-glow-level').textContent = theme.glowIntensity;
    if (k === 'glow') setEl.querySelector('[data-k="glowIntensity"]').disabled = !theme.glow;
    applyTheme();
    saveTheme();
  });
  setEl.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) setEl.style.display = 'none';
    else if (e.target.closest('[data-panel-size]')) {
      const compact = e.target.closest('[data-panel-size]').dataset.panelSize === 'compact';
      setPanelSize(compact ? 440 : 340, compact ? 180 : 460);
      setEl.style.display = 'none';
      updateJump();
    }
    else if (e.target.closest('[data-reset]')) {
      theme = Object.assign({}, THEME_DEFAULTS);
      applyTheme(); saveTheme(); buildSettings();
    }
  });
  $('tvcr-gear').onclick = () => {
    if (setEl.style.display === 'none') { buildSettings(); setEl.style.display = 'block'; }
    else setEl.style.display = 'none';
  };

  $('tvcr-send').onclick = send;
  $('tvcr-in').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }   // Shift+Enter = new line
  });
  $('tvcr-in').addEventListener('input', grow);
  // ✕ shuts the panel down completely until the next page load
  $('tvcr-close').onclick = () => {
    clearTimeout(timer);
    roomId = null;              // stops any refresh still on its way
    el.remove();
    style.remove();
    window.__tvChatRevival = false;
  };
  init();
})();
