const $ = (id) => document.getElementById(id);

const state = {
  cards: [],
  selectedId: null,
  pending: null,
  preview: null,
  details: new Map(),
  busy: false,
  importRequestId: 0,
  exportTarget: null,
  deleteTarget: null,
  settings: {
    loaded: false,
    busy: false,
  },
  lastExportUrl: null,
  // 本地日只由服务端给（/health），页面不自己算时间。
  today: null,
  yesterday: null,
  messages: new Map(),
  historyLoaded: new Set(),
  usage: new Map(),
  sending: new Set(),
  events: null,
  drawer: {
    tab: 'sched',
    loading: false,
    seq: 0,
    data: null,
    errors: {},
  },
};

const els = {
  brandMeta: $('brandMeta'),
  listCount: $('listCount'),
  libraryList: $('libraryList'),
  libraryEmpty: $('libraryEmpty'),
  noResults: $('noResults'),
  clearSearch: $('clearSearch'),
  search: $('search'),
  stageEmpty: $('stageEmpty'),
  emptyTitle: $('emptyTitle'),
  emptyText: $('emptyText'),
  stageImport: $('stageImport'),
  stageIntro: $('stageIntro'),
  introAvatar: $('introAvatar'),
  introName: $('introName'),
  introCompat: $('introCompat'),
  introMeta: $('introMeta'),
  introDesc: $('introDesc'),
  introTags: $('introTags'),
  introNotes: $('introNotes'),
  introStart: $('introStart'),
  chatShell: $('chatShell'),
  chatAvatar: $('chatAvatar'),
  chatName: $('chatName'),
  chatState: $('chatState'),
  chatQuota: $('chatQuota'),
  chatMeta: $('chatMeta'),
  drawerOpen: $('drawerOpen'),
  drawerDialog: $('drawerDialog'),
  drawerClose: $('drawerClose'),
  drawerRefresh: $('drawerRefresh'),
  drawerTabs: $('drawerTabs'),
  drawerSummary: $('drawerSummary'),
  tickList: $('tickList'),
  factList: $('factList'),
  summaryList: $('summaryList'),
  todayPanels: $('todayPanels'),
  usagePanel: $('usagePanel'),
  chatPlaceholderTitle: $('chatPlaceholderTitle'),
  chatPlaceholderText: $('chatPlaceholderText'),
  chatBody: $('chatBody'),
  chatPlaceholder: $('chatPlaceholder'),
  chatMessages: $('chatMessages'),
  composerInput: $('composerInput'),
  composerSend: $('composerSend'),
  menuBtn: $('menuBtn'),
  railClose: $('railClose'),
  railBackdrop: $('railBackdrop'),
  importDialog: $('importDialog'),
  importClose: $('importClose'),
  importCancel: $('importCancel'),
  importConfirm: $('importConfirm'),
  importOverwrite: $('importOverwrite'),
  importFootNote: $('importFootNote'),
  fileInput: $('fileInput'),
  dropzone: $('dropzone'),
  loadingFile: $('loadingFile'),
  previewAvatar: $('previewAvatar'),
  previewName: $('previewName'),
  previewMeta: $('previewMeta'),
  previewTags: $('previewTags'),
  previewDesc: $('previewDesc'),
  previewNotes: $('previewNotes'),
  dupAvatar: $('dupAvatar'),
  dupName: $('dupName'),
  dupMeta: $('dupMeta'),
  importErrorTitle: $('importErrorTitle'),
  importErrorText: $('importErrorText'),
  exportDialog: $('exportDialog'),
  exportClose: $('exportClose'),
  exportAvatar: $('exportAvatar'),
  exportName: $('exportName'),
  exportMeta: $('exportMeta'),
  exportPng: $('exportPng'),
  exportJson: $('exportJson'),
  deleteDialog: $('deleteDialog'),
  deleteClose: $('deleteClose'),
  deleteAvatar: $('deleteAvatar'),
  deleteName: $('deleteName'),
  deleteMeta: $('deleteMeta'),
  deleteWarning: $('deleteWarning'),
  deleteCancel: $('deleteCancel'),
  deleteConfirm: $('deleteConfirm'),
  settingsOpen: $('settingsOpen'),
  settingsDialog: $('settingsDialog'),
  settingsClose: $('settingsClose'),
  settingsCancel: $('settingsCancel'),
  settingsSave: $('settingsSave'),
  settingsForm: $('settingsForm'),
  settingsError: $('settingsError'),
  llmBaseUrl: $('llmBaseUrl'),
  llmApiKey: $('llmApiKey'),
  llmApiKeyHint: $('llmApiKeyHint'),
  llmChatModel: $('llmChatModel'),
  llmUtilityModel: $('llmUtilityModel'),
  toast: $('toast'),
};

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function initial(name) {
  return Array.from(String(name ?? '').trim())[0] ?? '她';
}

function avatarHtml(card, className) {
  const fallback = esc(initial(card.name));
  if (card.avatar_url) {
    return `<span class="${className}"><img src="${esc(card.avatar_url)}" alt="" data-fallback="${fallback}"></span>`;
  }
  return `<span class="${className}"><span class="avatar__fallback">${fallback}</span></span>`;
}

function replaceWithFallback(image) {
  const fallback = document.createElement('span');
  fallback.className = 'avatar__fallback';
  fallback.textContent = image.dataset.fallback ?? '她';
  image.replaceWith(fallback);
}

function wireAvatars(root) {
  for (const image of root.querySelectorAll('img[data-fallback]')) {
    if (image.complete && image.naturalWidth === 0) {
      replaceWithFallback(image);
      continue;
    }
    image.addEventListener('error', () => replaceWithFallback(image), { once: true });
  }
}

function stateBadge(card) {
  if (!card.state_word) {
    return '';
  }
  return `<span class="state state--${esc(card.state)}"><span class="dot" aria-hidden="true"></span>${esc(card.state_word)}</span>`;
}

function compatBadge(card) {
  return card.compat === 'v1' ? '<span class="compat">兼容模式</span>' : '';
}

function budgetBadge(card) {
  if (card.state === 'unstarted') {
    return '';
  }
  const remaining = Number(card.today_remaining) || 0;
  const available = card.state !== 'dormant' && remaining > 0;
  const title = card.state === 'dormant'
    ? '她现在不生成新内容'
    : available
      ? `今天她还能主动找你 ${remaining} 次`
      : '今天不再主动';
  return `<span class="budget ${available ? '' : 'budget--none'}" title="${esc(title)}">主动 ${available ? remaining : '—'}</span>`;
}

function filteredCards() {
  const query = els.search.value.trim().toLowerCase();
  if (query === '') {
    return state.cards;
  }
  return state.cards.filter((card) => card.name.toLowerCase().includes(query));
}

function renderBrand() {
  els.brandMeta.textContent = state.cards.length > 0
    ? `本地常驻 · ${state.cards.length} 张卡`
    : '本地常驻';
  els.listCount.textContent = String(state.cards.length);
}

function renderLibrary() {
  const visible = filteredCards();
  const hasCards = state.cards.length > 0;

  els.libraryEmpty.hidden = hasCards;
  els.noResults.hidden = !hasCards || visible.length > 0;

  els.libraryList.innerHTML = visible.map((card) => {
    const selected = card.id === state.selectedId;
    const snippet = card.last_message ?? '还没聊过';
    const label = `${card.name}，${card.state_word ?? '未开始'}，${snippet}`;
    const action = card.state === 'unstarted'
      ? `<button class="btn btn--tiny btn--primary" type="button" data-start="${card.id}">开始聊天</button>`
      : budgetBadge(card);

    return `<div class="card ${selected ? 'is-selected' : ''}" data-id="${card.id}" tabindex="0" aria-current="${selected}" aria-label="${esc(label)}">
      ${avatarHtml(card, 'avatar avatar--sm')}
      <div class="card__body">
        <div class="card__top">
          <span class="card__name">${esc(card.name)}</span>
          ${stateBadge(card)}
          ${compatBadge(card)}
        </div>
        <span class="card__snippet">${esc(snippet)}</span>
      </div>
      <div class="card__meta">
        ${action}
        <div class="card__actions">
          <button class="mini-btn" type="button" data-export="${card.id}" aria-label="导出 ${esc(card.name)}" title="导出">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 2v8M5 7.5 8 10.5l3-3M3 12.5h10" />
            </svg>
          </button>
          <button class="mini-btn mini-btn--danger" type="button" data-delete="${card.id}" aria-label="删除 ${esc(card.name)}" title="删除">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2M6.8 7v3.4M9.2 7v3.4" />
            </svg>
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  wireAvatars(els.libraryList);
}

function renderEmpty() {
  const hasCards = state.cards.length > 0;
  els.emptyTitle.textContent = hasCards ? '她已经在自己的时间里了' : '还没有角色卡';
  els.emptyText.textContent = hasCards
    ? '从左边选一张卡，或者再拖一张进来。'
    : '把一张酒馆角色卡拖进来，先看看她是谁。';
}

function renderIntro(card) {
  const detail = state.details.get(card.id);
  els.introAvatar.innerHTML = avatarHtml(card, 'avatar avatar--xl');
  wireAvatars(els.introAvatar);
  els.introName.textContent = card.name;
  els.introCompat.hidden = card.compat !== 'v1';
  els.introMeta.textContent = '这张卡已经在库里了，点下面开始。';

  els.introDesc.textContent = detail?.description
    || '这张卡已经在库里了。点下面开始聊天，她会进入自己的时间线。';

  const tags = Array.isArray(detail?.tags) ? detail.tags : [];
  els.introTags.innerHTML = tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('');
  els.introTags.hidden = tags.length === 0;

  const notes = [];
  if (detail?.has_scripts) {
    notes.push('这张卡带脚本，已忽略执行。');
  }
  if (detail?.has_book) {
    notes.push('这张卡带世界书，原样保留，暂不注入。');
  }
  if (detail?.compat === 'v1' || card.compat === 'v1') {
    notes.push('按 V1 六字段读取，其余字段留空。');
  }
  els.introNotes.innerHTML = notes.map((note) => `<p class="note">${esc(note)}</p>`).join('');
  els.introNotes.hidden = notes.length === 0;
}

function currentCard() {
  return state.cards.find((item) => item.id === state.selectedId) ?? null;
}

/**
 * 时间全部由服务端算好：clock 是唯一时间源，页面不许碰时间（硬规则 1）。
 * `clock_text` 是本地 HH:mm，`local_day` 是本地 YYYY-MM-DD。
 * 这里只拼「今天/昨天」的措辞与日期分隔行，不做任何日期运算。
 */
function dayLabelOf(localDay) {
  if (!localDay) {
    return '';
  }
  const parts = localDay.split('-');
  const label = `${Number(parts[1])}月${Number(parts[2])}日`;
  if (state.today === localDay) {
    return `今天 · ${label}`;
  }
  if (state.yesterday === localDay) {
    return `昨天 · ${label}`;
  }
  return label;
}

function metaHtml(group) {
  const first = group.bubbles[0];
  const clock = first?.clock_text ?? '';
  if (!clock) {
    return '';
  }
  const who = group.role === 'user' ? '你' : esc(currentCard()?.name ?? '');
  return `<div class="msg__meta"><span>${who}</span><span aria-hidden="true">·</span><time>${esc(clock)}</time></div>`;
}

/**
 * 同一次生成的多条气泡合成一个消息块，与原型 `turn` + `bubbles` 的结构一致：
 * 一次回复只出现一个头像位、一组气泡。判据是 `bubble_index` 连续递增
 * （新一次回复总是从 0 开始），因此不需要读时间，SSE 与历史两条路径都适用。
 */
function groupMessages(list) {
  const groups = [];
  for (const message of list) {
    const previous = groups.at(-1);
    const last = previous?.bubbles.at(-1);
    const index = message.bubble_index;
    const continuous = previous
      && previous.role === 'char'
      && message.role === 'char'
      && Number.isInteger(index)
      && Number.isInteger(last?.bubble_index)
      && index === last.bubble_index + 1;
    if (continuous) {
      previous.bubbles.push(message);
      continue;
    }
    groups.push({ role: message.role, bubbles: [message] });
  }
  return groups;
}

function renderMessages() {
  const card = currentCard();
  const sessionId = card?.session_id;
  const list = sessionId ? state.messages.get(sessionId) ?? [] : [];

  // 先按 local_day 变化给每个组打上日期分隔行（票 16），
  // 组内多气泡共用一个时间 meta（同一次生成共享 batchAt）。
  const groups = groupMessages(list);
  let lastDay = '';
  els.chatMessages.innerHTML = groups.map((group) => {
    const mine = group.role === 'user';
    const day = group.bubbles[0]?.local_day && group.bubbles[0].local_day !== lastDay
      ? `<li class="day">${esc(dayLabelOf(group.bubbles[0].local_day))}</li>`
      : '';
    if (group.bubbles[0]?.local_day) {
      lastDay = group.bubbles[0].local_day;
    }
    const bubbles = group.bubbles
      .map((message) => `<div class="msg__bubble">${esc(message.content)}</div>`)
      .join('');
    return `${day}<li class="msg ${mine ? 'msg--user' : 'msg--char'} msg--group">${metaHtml(group)}<div class="msg__bubbles">${bubbles}</div></li>`;
  }).join('');
  els.chatMessages.hidden = list.length === 0;
  els.chatPlaceholder.hidden = list.length > 0;

  if (list.length > 0) {
    els.chatBody.scrollTop = els.chatBody.scrollHeight;
  }
}

function updateComposer(card) {
  const unavailable = !card || !card.session_id || card.state === 'dormant';
  const sending = card?.session_id ? state.sending.has(card.session_id) : false;
  els.composerInput.disabled = unavailable || sending;
  els.composerSend.disabled = unavailable
    || sending
    || els.composerInput.value.trim() === '';
  els.composerSend.textContent = sending ? '发送中…' : '发送';

  if (!card || !card.session_id) {
    els.composerInput.placeholder = '开始聊天后才能发消息';
  } else if (card.state === 'dormant') {
    els.composerInput.placeholder = '她现在不太方便';
  } else {
    els.composerInput.placeholder = '说点什么…';
  }
}

async function loadHistory(card) {
  const sessionId = card?.session_id;
  if (!sessionId || state.historyLoaded.has(sessionId)) {
    return;
  }

  state.historyLoaded.add(sessionId);
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages?limit=100`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.json();
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const byId = new Map();
    for (const message of [...(state.messages.get(sessionId) ?? []), ...incoming]) {
      byId.set(message.id, message);
    }
    state.messages.set(
      sessionId,
      [...byId.values()].sort((left, right) => Number(left.id) - Number(right.id)),
    );
    if (currentCard()?.session_id === sessionId) {
      renderMessages();
    }
  } catch {
    state.historyLoaded.delete(sessionId);
  }
}

function appendMessage(sessionId, message) {
  if (!sessionId || !message || message.id === undefined) {
    return false;
  }
  const list = state.messages.get(sessionId) ?? [];
  if (list.some((item) => item.id === message.id)) {
    return false;
  }
  list.push(message);
  state.messages.set(sessionId, list);
  return true;
}

function parseEventFrame(frame) {
  let name = 'message';
  const dataLines = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      name = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const raw = dataLines.join('\n');
  try {
    return { name, data: JSON.parse(raw) };
  } catch {
    return { name, data: null };
  }
}

async function consumeEvents(response, sessionId, pendingText) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('no stream');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });

    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);

      const event = parseEventFrame(frame);
      if (event) {
        if (event.name === 'user_ack') {
          appendMessage(sessionId, {
            id: event.data?.message_id,
            role: 'user',
            content: pendingText,
            is_proactive: 0,
            bubble_index: null,
            incomplete: 0,
            created_at: event.data?.created_at ?? '',
            clock_text: event.data?.clock_text ?? null,
            local_day: event.data?.local_day ?? null,
          });
          renderMessages();
        } else if (event.name === 'bubble') {
          appendMessage(sessionId, {
            id: event.data?.message_id,
            role: 'char',
            content: event.data?.text ?? '',
            is_proactive: 0,
            bubble_index: event.data?.bubble_index ?? null,
            incomplete: event.data?.incomplete ? 1 : 0,
            created_at: event.data?.created_at ?? '',
            clock_text: event.data?.clock_text ?? null,
            local_day: event.data?.local_day ?? null,
          });
          renderMessages();
        } else if (event.name === 'done') {
          const quota = event.data?.quota;
          if (quota) {
            state.usage.set(sessionId, {
              session_id: sessionId,
              used: quota.used,
              limit: quota.limit,
              ratio: quota.ratio,
              warn: quota.warn,
              exhausted: quota.exhausted ?? quota.status === 'exhausted',
              status: quota.status,
            });
            updateQuota(currentCard());
          }
        } else if (event.name === 'error') {
          showToast(event.data?.message ?? '她这次没接上话，请再试一次');
        }
      }

      boundary = /\r?\n\r?\n/.exec(buffer);
    }
  }
}

async function sendMessage() {
  const card = currentCard();
  const sessionId = card?.session_id;
  if (!card || !sessionId || state.sending.has(sessionId)) {
    return;
  }

  const text = els.composerInput.value.trim();
  if (text === '') {
    return;
  }

  state.sending.add(sessionId);
  updateComposer(card);

  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showToast(body.error?.message ?? '消息没有发出去');
      return;
    }

    els.composerInput.value = '';
    await consumeEvents(response, sessionId, text);
  } catch {
    showToast('她那边没有回应，请稍后再试');
  } finally {
    state.sending.delete(sessionId);
    updateComposer(currentCard());
    void loadCards();
  }
}

function connectEvents() {
  if (state.events || typeof EventSource === 'undefined') {
    return;
  }

  const source = new EventSource('/api/events');
  state.events = source;

  source.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const sessionId = Number(payload?.session_id);
    if (appendMessage(sessionId, payload?.message)) {
      if (currentCard()?.session_id === sessionId) {
        renderMessages();
      }
    }
    void loadCards();
  });

  for (const topic of ['state', 'quota', 'import', 'tick']) {
    source.addEventListener(topic, (event) => {
      if (topic === 'quota') {
        try {
          const payload = JSON.parse(event.data);
          const sessionId = Number(payload?.session_id);
          const ratio = Number(payload?.ratio) || 0;
          state.usage.set(sessionId, {
            session_id: sessionId,
            used: payload?.used,
            limit: payload?.limit,
            ratio,
            warn: payload?.warn === true,
            exhausted: ratio >= 1,
            status: ratio >= 1 ? 'exhausted' : (payload?.warn ? 'warn70' : 'ok'),
          });
          updateQuota(currentCard());
        } catch {
          // 坏帧忽略，等下一次用量事件或 GET /api/usage。
        }
      }
      void loadCards();
    });
  }
}

function renderChat(card) {
  els.chatAvatar.innerHTML = avatarHtml(card, 'avatar avatar--lg');
  wireAvatars(els.chatAvatar);
  els.chatName.textContent = card.name;
  els.chatState.className = `state state--${card.state}`;
  els.chatState.innerHTML = `<span class="dot" aria-hidden="true"></span>${esc(card.state_word ?? '')}`;
  updateQuota(card);

  if (card.state === 'paused') {
    els.chatMeta.textContent = '她现在在忙，不会主动开口。';
    els.chatPlaceholderTitle.textContent = '她现在在忙';
    els.chatPlaceholderText.textContent = '她不会主动开口，但你有话可以说。';
  } else if (card.state === 'dormant') {
    els.chatMeta.textContent = '她现在不太方便。';
    els.chatPlaceholderTitle.textContent = '她现在不太方便';
    els.chatPlaceholderText.textContent = '她只会沉默，或很短地回应。';
  } else {
    els.chatMeta.textContent = '她有自己的时间线，也有自己的节奏。';
    els.chatPlaceholderTitle.textContent = '她已经醒着了';
    els.chatPlaceholderText.textContent = '说点什么，她会按自己的节奏回你。';
  }

  updateComposer(card);
  renderMessages();
  void loadHistory(card);
}

function renderStage() {
  const card = state.cards.find((item) => item.id === state.selectedId) ?? null;

  els.stageEmpty.hidden = card !== null;
  els.stageIntro.hidden = card === null || card.state !== 'unstarted';
  els.chatShell.hidden = card === null || card.state === 'unstarted';

  if (card === null) {
    renderEmpty();
    return;
  }
  if (card.state === 'unstarted') {
    renderIntro(card);
    return;
  }
  renderChat(card);
}

function render() {
  renderBrand();
  renderLibrary();
  renderStage();
}

function selectCard(id) {
  state.selectedId = id;
  render();
  closeRail();
}

async function loadCards() {
  try {
    const response = await fetch('/api/cards', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.json();
    state.cards = Array.isArray(body.cards) ? body.cards : [];
    if (!state.cards.some((card) => card.id === state.selectedId)) {
      state.selectedId = state.cards[0]?.id ?? null;
    }
    render();
    void loadUsage();
  } catch {
    showToast('服务没有响应，请确认本地进程还在');
  }
}

async function loadUsage() {
  try {
    const response = await fetch('/api/usage', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return;
    }
    const body = await response.json();
    const next = new Map();
    for (const row of Array.isArray(body.sessions) ? body.sessions : []) {
      next.set(Number(row.session_id), row);
    }
    state.usage = next;
    updateQuota(currentCard());
  } catch {
    // 用量角标是只读装饰；服务短暂不可用时不打扰聊天。
  }
}

function updateQuota(card) {
  const row = card?.session_id ? state.usage.get(card.session_id) : null;
  if (!row) {
    els.chatQuota.hidden = true;
    els.chatQuota.textContent = '';
    return;
  }
  const percent = Math.max(0, Math.min(100, Math.round((Number(row.ratio) || 0) * 100)));
  els.chatQuota.hidden = false;
  els.chatQuota.textContent = `已用 ${percent}%`;
  els.chatQuota.className = `quota-badge${row.exhausted
    ? ' quota-badge--exhausted'
    : row.warn
      ? ' quota-badge--warn'
      : ''}`;
}

/* ---------- detail drawer ---------- */
const TICK_REASONS = {
  send: '发出主动消息',
  state_not_active: '会话在忙或已安静，不主动开口',
  cold_start: '刚启动，先等她回过神',
  budget_global_full: '今日全局预算已满',
  budget_session_full: '本角色今日主动次数已满',
  too_soon: '刚收到你的消息，间隔不足',
  no_anchor: '没有可用的生活事件或待用记忆',
  low_willingness: '意愿低于阈值 0.60',
  silenced: '今天已经开过口，先收住',
  busy: '上一轮还没结束，本次跳过',
  llm_error: '这次生成没有完成',
  llm_bad_response: '这次回复不合格，已丢弃',
  style_blocked: '这次回复带系统腔，已重生成',
  too_long: '这次回复太长，已丢弃',
  anchor_fail: '没有正确引用锚点，已丢弃且不扣次数',
  race: '刚好被你抢先，本次不重复开口',
};

const TICK_TRIGGERS = {
  timer: '定时',
  hard: '硬触发',
  manual: '手动',
};

const SUBJECT_WORDS = {
  user: '你',
  char: '她',
  world: '世界',
};

const FEED_WORDS = {
  weather: '天气',
  holiday: '节日',
  news: '头条',
};

function isoTime(value) {
  const text = String(value ?? '');
  return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : (text || '—');
}

function isoDate(value) {
  const text = String(value ?? '');
  return text.length >= 10 ? text.slice(0, 10) : (text || '—');
}

function tokenText(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function drawerPercent(row) {
  return Math.max(0, Math.min(100, Math.round((Number(row?.ratio) || 0) * 100)));
}

function currentDrawerData() {
  return state.drawer.data ?? {
    ticks: null,
    memory: null,
    today: null,
    usage: null,
  };
}

async function openDrawer() {
  if (!els.drawerDialog.open) {
    els.drawerDialog.showModal();
  }
  state.drawer.tab = 'sched';
  syncTabs();
  await loadDrawer();
}

function closeDrawer() {
  if (els.drawerDialog.open) {
    els.drawerDialog.close();
  }
}

async function loadDrawer() {
  const card = currentCard();
  const sessionId = card?.session_id;
  if (!sessionId) {
    renderDrawer();
    return;
  }

  const seq = state.drawer.seq + 1;
  state.drawer.seq = seq;
  state.drawer.loading = true;
  state.drawer.errors = {};
  renderDrawer();

  const requests = [
    ['ticks', `/api/sessions/${sessionId}/debug/ticks?limit=20`],
    ['memory', `/api/sessions/${sessionId}/memory`],
    ['today', `/api/sessions/${sessionId}/today`],
    ['usage', '/api/usage'],
  ];
  const results = await Promise.allSettled(requests.map(async ([key, url]) => {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return [key, await response.json()];
  }));

  if (seq !== state.drawer.seq || !els.drawerDialog.open) {
    return;
  }

  const data = {
    ticks: null,
    memory: null,
    today: null,
    usage: null,
  };
  results.forEach((result, index) => {
    const key = requests[index][0];
    if (result.status === 'fulfilled') {
      data[key] = result.value[1];
    } else {
      state.drawer.errors[key] = true;
    }
  });
  state.drawer.data = data;
  state.drawer.loading = false;
  renderDrawer();
}

function syncTabs() {
  for (const tab of els.drawerTabs.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${state.drawer.tab}`;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) {
      panel.hidden = !selected;
    }
  }
}

function selectTab(name, focus = false) {
  state.drawer.tab = name;
  syncTabs();
  if (focus) {
    document.getElementById(`tab-${name}`)?.focus();
  }
}

function drawerError(key, fallback) {
  if (state.drawer.errors[key]) {
    return '<p class="drawer-error">暂时读不到，刷新或稍后再试。</p>';
  }
  return `<p class="panel-note">${fallback}</p>`;
}

function renderDrawer() {
  const card = currentCard();
  if (!card) {
    return;
  }
  const data = currentDrawerData();
  const usage = data.usage;
  const row = usage?.sessions?.find((item) => Number(item.session_id) === Number(card.session_id));
  const day = usage?.daily?.[0];
  if (state.drawer.loading && !state.drawer.data) {
    els.drawerSummary.innerHTML = `<span>正在读取…</span>`;
  } else if (row) {
    els.drawerSummary.innerHTML = `<span>${esc(card.state_word ?? '')}</span><span>今日对话 <b>${tokenText(day?.chat)}</b> token</span><span>主动 <b>${tokenText(day?.proactive)}</b></span><span>已用 <b>${drawerPercent(row)}%</b></span>`;
  } else {
    els.drawerSummary.innerHTML = `<span>${esc(card.state_word ?? '')}</span><span>${state.drawer.errors.usage ? '用量暂时读不到' : '今天还没有用量记录'}</span>`;
  }
  renderTicks(data);
  renderFacts(data);
  renderToday(data);
  renderUsage(data, card);
  syncTabs();
}

function renderTicks(data) {
  if (state.drawer.errors.ticks) {
    els.tickList.innerHTML = drawerError('ticks');
    return;
  }
  if (!data.ticks) {
    els.tickList.innerHTML = state.drawer.loading
      ? '<p class="panel-note">正在读取调度记录…</p>'
      : '<p class="panel-note">还没有调度记录。</p>';
    return;
  }
  const ticks = Array.isArray(data.ticks.ticks) ? data.ticks.ticks : [];
  if (ticks.length === 0) {
    els.tickList.innerHTML = '<p class="panel-note">还没有调度记录。</p>';
    return;
  }
  els.tickList.innerHTML = ticks.map((tick) => {
    const send = tick.decision === 'send';
    const reason = TICK_REASONS[tick.decision_reason] ?? (send ? '发出主动消息' : '本次不开口');
    const willingness = tick.willingness === null || tick.willingness === undefined
      ? ''
      : `<span class="log-will">意愿 ${Number(tick.willingness).toFixed(2)}</span>`;
    return `<div class="log-row">
      <time class="log-time">${esc(isoTime(tick.created_at))}</time>
      <div class="log-main">
        <div class="log-line">
          <span class="chip ${send ? 'chip--send' : 'chip--skip'}">${send ? '发送' : '跳过'}</span>
          <span class="chip">${esc(TICK_TRIGGERS[tick.trigger] ?? tick.trigger ?? '定时')}</span>
        </div>
        <p class="log-reason">${esc(reason)}</p>
        ${willingness}
      </div>
    </div>`;
  }).join('');
}

function factStatus(fact) {
  if (fact.valid_to) {
    return { word: '已过期', className: '' };
  }
  if (fact.status === 'pending') {
    return { word: '待用', className: 'chip--warn' };
  }
  if (fact.status === 'done') {
    return { word: '已沉淀', className: '' };
  }
  if (fact.status === 'dropped') {
    return { word: '已丢弃', className: '' };
  }
  return { word: fact.status ?? '', className: '' };
}

function renderFacts(data) {
  if (state.drawer.errors.memory) {
    els.factList.innerHTML = drawerError('memory');
    els.summaryList.innerHTML = '';
    return;
  }
  if (!data.memory) {
    const note = state.drawer.loading ? '正在读取记忆…' : '还没有抽取到记忆。';
    els.factList.innerHTML = `<p class="panel-note">${note}</p>`;
    els.summaryList.innerHTML = '';
    return;
  }
  const facts = Array.isArray(data.memory.facts) ? data.memory.facts : [];
  const summaries = Array.isArray(data.memory.summaries) ? data.memory.summaries : [];
  els.factList.innerHTML = facts.length === 0
    ? '<p class="panel-note">还没有抽取到记忆。</p>'
    : facts.map((fact) => {
      const status = factStatus(fact);
      return `<div class="fact">
        <div class="fact__top">
          <span class="chip">${esc(SUBJECT_WORDS[fact.subject] ?? fact.subject ?? '')}</span>
          <span class="fact__key">${esc(fact.key)}</span>
          <span class="chip ${status.className}">${esc(status.word)}</span>
        </div>
        <p class="fact__body">${esc(fact.value)}</p>
        <div class="fact__meta">${esc(isoDate(fact.valid_from))}${fact.valid_to ? ` · 到 ${esc(isoDate(fact.valid_to))}` : ''}</div>
      </div>`;
    }).join('');
  els.summaryList.innerHTML = summaries.length === 0
    ? '<p class="panel-note">还没有对话摘要。</p>'
    : summaries.map((summary) => `<div class="summary">${esc(summary.content)}<div class="summary__meta">${esc(isoTime(summary.created_at))}</div></div>`).join('');
}

function renderToday(data) {
  if (state.drawer.errors.today) {
    els.todayPanels.innerHTML = drawerError('today');
    return;
  }
  if (!data.today) {
    els.todayPanels.innerHTML = state.drawer.loading
      ? '<p class="panel-note">正在读取她的今天…</p>'
      : '<p class="panel-note">今天还没有生活事件。</p>';
    return;
  }
  const events = Array.isArray(data.today.events) ? data.today.events : [];
  const feeds = Array.isArray(data.today.feeds) ? data.today.feeds : [];
  els.todayPanels.innerHTML = `
    <div class="section-title">生活事件 · ${events.length} 条</div>
    ${events.length === 0 ? '<p class="panel-note">今天还没有生活事件。</p>' : events.map((event, index) => `<div class="event ${event.used_by_msg_id ? 'is-used' : ''}">
      <span class="event__idx">${String(index + 1).padStart(2, '0')}</span>
      <div>
        <p class="event__text">${esc(event.content)}</p>
        <div class="event__meta">${event.used_by_msg_id ? '已经用于一次主动开口' : '还没用'}</div>
      </div>
    </div>`).join('')}
    <div class="section-title">世界信息</div>
    ${feeds.length === 0 ? '<p class="panel-note">今天没有抓到世界信息，生活事件按她自己的日子生成。</p>' : feeds.map((feed) => `<div class="feed">
      <span class="chip feed__kind">${esc(FEED_WORDS[feed.kind] ?? '信息')}</span>
      <div class="feed__text">${esc(feed.content)}<small>${esc(isoTime(feed.fetched_at))}</small></div>
    </div>`).join('')}
  `;
}

function renderUsage(data, card) {
  if (state.drawer.errors.usage) {
    els.usagePanel.innerHTML = drawerError('usage');
    return;
  }
  if (!data.usage) {
    els.usagePanel.innerHTML = state.drawer.loading
      ? '<p class="panel-note">正在读取用量…</p>'
      : '<p class="panel-note">今天还没有用量记录。</p>';
    return;
  }
  const row = data.usage.sessions?.find((item) => Number(item.session_id) === Number(card.session_id));
  if (!row) {
    els.usagePanel.innerHTML = '<p class="panel-note">今天还没有用量记录。</p>';
    return;
  }
  const percent = drawerPercent(row);
  const daily = Array.isArray(data.usage.daily) ? data.usage.daily[0] : null;
  const entries = (Array.isArray(data.usage.entries) ? data.usage.entries : [])
    .filter((entry) => Number(entry.session_id) === Number(card.session_id))
    .slice()
    .reverse()
    .slice(0, 12);
  const kindWords = { chat: '对话', proactive: '主动', refill: '续额' };
  const rows = entries.length === 0
    ? '<p class="panel-note">今天还没有生成记录。</p>'
    : entries.map((entry) => `<div class="usage-row">
      <time>${esc(isoTime(entry.created_at))}</time>
      <span class="usage-who">${esc(kindWords[entry.kind] ?? entry.kind)}${entry.estimated ? ' · 估算' : ''}</span>
      <span class="usage-num">${tokenText(entry.amount)} token</span>
    </div>`).join('');
  els.usagePanel.innerHTML = `
    <div class="usage-total"><strong>${percent}%</strong><span>${tokenText(row.used)} / ${tokenText(row.limit)} token</span></div>
    <div class="usage-bar" aria-hidden="true"><i style="width:${percent}%"></i></div>
    <div class="usage-sub"><span>已用 ${tokenText(row.used)}</span><span>${row.exhausted ? '她安静下来了' : row.warn ? '已过提醒线' : '还在日常范围'}</span></div>
    <div class="section-title">今天</div>
    <div class="usage-row"><span class="usage-who">对话</span><span class="usage-num">${tokenText(daily?.chat)} token</span></div>
    <div class="usage-row"><span class="usage-who">主动开口</span><span class="usage-num">${tokenText(daily?.proactive)} token</span></div>
    <div class="usage-row"><span class="usage-who">续额</span><span class="usage-num">+${tokenText(daily?.refill)}</span></div>
    <div class="section-title">最近流水</div>
    ${rows}
  `;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.remove('is-visible');
  void els.toast.offsetWidth;
  els.toast.classList.add('is-visible');
}

function openRail() {
  document.body.classList.add('rail-open');
  els.railBackdrop.hidden = false;
  els.menuBtn.setAttribute('aria-expanded', 'true');
}

function closeRail() {
  document.body.classList.remove('rail-open');
  els.railBackdrop.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
}

function showImportSection(name) {
  for (const section of document.querySelectorAll('[data-import-section]')) {
    section.hidden = section.dataset.importSection !== name;
  }

  els.importConfirm.hidden = name !== 'preview';
  els.importOverwrite.hidden = name !== 'duplicate';

  const notes = {
    idle: '导入后可在角色库无损导出',
    loading: '正在读取卡片内容…',
    preview: '字段会原样落库；extensions 逐字节保留。',
    duplicate: '覆盖会保留会话与记忆，只更新卡面。',
    error: '失败不会落库。',
  };
  els.importFootNote.textContent = notes[name] ?? '';
}

function resetImport() {
  state.importRequestId += 1;
  state.pending = null;
  state.preview = null;
  els.fileInput.value = '';
  els.loadingFile.textContent = '';
  els.importErrorTitle.textContent = '这张卡解析不出来';
  els.importErrorText.textContent = '换一张卡再试。';
  setImportBusy(false);
  showImportSection('idle');
}

function openImport() {
  resetImport();
  if (!els.importDialog.open) {
    els.importDialog.showModal();
  }
}

function closeImport() {
  if (els.importDialog.open) {
    els.importDialog.close();
  }
}

function setImportBusy(busy) {
  els.importConfirm.disabled = busy;
  els.importOverwrite.disabled = busy;
  els.importCancel.disabled = busy;
  els.importClose.disabled = busy;
}

function fillPreview(preview) {
  els.previewAvatar.innerHTML = avatarHtml({ name: preview.name, avatar_url: null }, 'avatar avatar--md');
  wireAvatars(els.previewAvatar);
  els.previewName.textContent = preview.name;
  els.previewMeta.textContent = preview.compat === 'v2' ? 'chara_card_v2' : 'V1 · 兼容模式';

  const tags = Array.isArray(preview.tags) ? preview.tags : [];
  els.previewTags.innerHTML = tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('');
  els.previewTags.hidden = tags.length === 0;

  const description = preview.description || '（这张卡没有写描述）';
  if (description.length > 500) {
    els.previewDesc.innerHTML = `<details class="desc"><summary>描述（${description.length} 字）</summary><p>${esc(description)}</p></details>`;
  } else {
    els.previewDesc.innerHTML = `<p class="desc">${esc(description)}</p>`;
  }

  const notes = [];
  if (preview.compat === 'v1') {
    notes.push('按 V1 六字段读取，其余字段留空。');
  }
  if (preview.has_scripts) {
    notes.push('这张卡带脚本，已忽略执行。');
  }
  if (preview.has_book) {
    notes.push('这张卡带世界书，原样保留，暂不注入。');
  }
  els.previewNotes.innerHTML = notes.map((note) => `<p class="note">${esc(note)}</p>`).join('');
  els.previewNotes.hidden = notes.length === 0;
}

function fillDuplicate(preview) {
  const existing = state.cards.find((card) => card.id === preview.duplicate?.id);
  const card = existing ?? { name: preview.name, avatar_url: null };
  els.dupAvatar.innerHTML = avatarHtml(card, 'avatar avatar--sm');
  wireAvatars(els.dupAvatar);
  els.dupName.textContent = existing?.name ?? preview.name;
  els.dupMeta.textContent = existing
    ? `已导入 · ${existing.compat === 'v2' ? 'V2' : 'V1 兼容'}`
    : '已经在库里';
}

function showImportError(title, text) {
  els.importErrorTitle.textContent = title;
  els.importErrorText.textContent = text;
  showImportSection('error');
}

async function handleFile(file) {
  if (!file) {
    return;
  }

  const dot = file.name.lastIndexOf('.');
  const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  if (extension !== '.png' && extension !== '.json') {
    showImportError('只支持 PNG 或 JSON 角色卡', '换一张卡再试。');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showImportError('这张卡太大了', '单张卡不能超过 20MB。');
    return;
  }

  const requestId = state.importRequestId + 1;
  state.importRequestId = requestId;
  els.loadingFile.textContent = file.name;
  showImportSection('loading');

  try {
    const bytes = await file.arrayBuffer();
    if (requestId !== state.importRequestId) {
      return;
    }

    const response = await fetch('/api/cards/preview', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: bytes,
    });
    const body = await response.json().catch(() => ({}));

    if (requestId !== state.importRequestId) {
      return;
    }
    if (!response.ok) {
      showImportError(body.error?.message ?? '这张卡解析不出来', '换一张卡再试。');
      return;
    }

    state.pending = { token: body.token, filename: file.name };
    state.preview = body;

    if (body.duplicate) {
      fillDuplicate(body);
      showImportSection('duplicate');
    } else {
      fillPreview(body);
      showImportSection('preview');
    }
  } catch {
    if (requestId === state.importRequestId) {
      showImportError('服务没有响应', '请确认本地进程还在运行。');
    }
  }
}

async function commitPending(mode) {
  if (state.busy || state.pending === null) {
    return;
  }

  state.busy = true;
  setImportBusy(true);

  try {
    const response = await fetch('/api/cards/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.pending.token, mode }),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (body.error?.code === 'card_duplicate' && state.preview !== null) {
        fillDuplicate(state.preview);
        showImportSection('duplicate');
      } else {
        showImportError(
          body.error?.message ?? '这次没有导入成功',
          '失败不会落库，可以重新选择文件。',
        );
      }
      return;
    }

    const preview = state.preview;
    if (preview !== null) {
      state.details.set(body.card.id, {
        description: preview.description,
        tags: preview.tags,
        compat: preview.compat,
        has_scripts: preview.has_scripts,
        has_book: preview.has_book,
      });
    }

    await loadCards();
    state.selectedId = body.card.id;
    render();
    closeImport();
    showToast('已经把她放进来了');
  } catch {
    showImportError('服务没有响应', '这次没有落库，请稍后再试。');
  } finally {
    state.busy = false;
    setImportBusy(false);
  }
}

async function startCard(id) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  try {
    const response = await fetch(`/api/cards/${id}/start`, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(body.error?.message ?? '没能开始聊天');
      return;
    }

    await loadCards();
    state.selectedId = id;
    render();
    closeRail();
    showToast('她醒着了');
  } catch {
    showToast('服务没有响应，请稍后再试');
  } finally {
    state.busy = false;
  }
}

function setExportBusy(busy) {
  els.exportPng.disabled = busy;
  els.exportJson.disabled = busy;
  els.exportClose.disabled = busy;
}

function openExport(id) {
  const card = state.cards.find((item) => item.id === id);
  if (!card) {
    return;
  }
  state.exportTarget = card;
  els.exportAvatar.innerHTML = avatarHtml(card, 'avatar avatar--sm');
  wireAvatars(els.exportAvatar);
  els.exportName.textContent = card.name;
  els.exportMeta.textContent = card.compat === 'v2'
    ? 'chara_card_v2 · 可导出 PNG / JSON'
    : 'V1 兼容模式 · 可导出 PNG / JSON';
  setExportBusy(false);
  els.exportDialog.showModal();
}

function closeExport() {
  if (els.exportDialog.open) {
    els.exportDialog.close();
  }
}

async function downloadExport(format) {
  const card = state.exportTarget;
  if (!card || state.busy) {
    return;
  }

  state.busy = true;
  setExportBusy(true);

  try {
    const response = await fetch(`/api/cards/${card.id}/export?format=${format}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showToast(body.error?.message ?? '导出没有成功');
      return;
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    let filename = `${card.name}.${format}`;
    if (encoded) {
      try {
        filename = decodeURIComponent(encoded[1].trim());
      } catch {
        // 文件名头坏了就退回卡名。
      }
    }

    const url = URL.createObjectURL(blob);
    if (state.lastExportUrl) {
      URL.revokeObjectURL(state.lastExportUrl);
    }
    state.lastExportUrl = url;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();

    closeExport();
    showToast(`已导出 ${filename}`);
  } catch {
    showToast('服务没有响应，导出没有成功');
  } finally {
    state.busy = false;
    setExportBusy(false);
  }
}

function currentDeleteScope() {
  return document.querySelector('input[name="deleteScope"]:checked')?.value ?? 'card';
}

function updateDeleteWarning() {
  const card = state.deleteTarget;
  if (!card || card.state !== 'active') {
    els.deleteWarning.hidden = true;
    els.deleteWarning.textContent = '';
    return;
  }
  els.deleteWarning.hidden = false;
  els.deleteWarning.textContent = currentDeleteScope() === 'records'
    ? '她正在活跃中，删除会先让她停下来，对话记录会一并清掉。'
    : '她正在活跃中，删除会先让她停下来。';
}

function setDeleteBusy(busy) {
  els.deleteConfirm.disabled = busy;
  els.deleteCancel.disabled = busy;
  els.deleteClose.disabled = busy;
}

function openDelete(id) {
  const card = state.cards.find((item) => item.id === id);
  if (!card) {
    return;
  }
  state.deleteTarget = card;
  els.deleteAvatar.innerHTML = avatarHtml(card, 'avatar avatar--sm');
  wireAvatars(els.deleteAvatar);
  els.deleteName.textContent = card.name;
  const compatLabel = card.compat === 'v2' ? 'V2 卡' : 'V1 兼容';
  els.deleteMeta.textContent = card.state_word
    ? `${card.state_word} · ${compatLabel}`
    : `还没开始 · ${compatLabel}`;
  const defaultScope = document.querySelector('input[name="deleteScope"][value="card"]');
  if (defaultScope) {
    defaultScope.checked = true;
  }
  updateDeleteWarning();
  setDeleteBusy(false);
  els.deleteDialog.showModal();
}

function closeDelete() {
  if (els.deleteDialog.open) {
    els.deleteDialog.close();
  }
}

async function confirmDelete() {
  const card = state.deleteTarget;
  if (!card || state.busy) {
    return;
  }

  const scope = currentDeleteScope();
  state.busy = true;
  setDeleteBusy(true);

  try {
    const response = await fetch(`/api/cards/${card.id}?scope=${scope}`, { method: 'DELETE' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(body.error?.message ?? '没能删掉');
      return;
    }

    if (state.selectedId === card.id) {
      state.selectedId = null;
    }
    closeDelete();
    await loadCards();
    showToast(scope === 'records' ? '已经删掉了，记录也清干净了' : '已经删掉了');
  } catch {
    showToast('服务没有响应，请稍后再试');
  } finally {
    state.busy = false;
    setDeleteBusy(false);
  }
}

/* ---------- model settings ---------- */
function maskHint(masked) {
  return masked
    ? `已保存 ${masked}，留空不改。`
    : '只存在本机的配置文件里，界面上永远只回后四位。';
}

function setSettingsBusy(busy) {
  state.settings.busy = busy;
  // 没读到当前配置时不给保存，避免把空表单写回磁盘覆盖掉已有设置。
  els.settingsSave.disabled = busy || !state.settings.loaded;
  els.settingsCancel.disabled = busy;
  els.settingsClose.disabled = busy;
  els.settingsSave.textContent = busy ? '保存中…' : '保存';
}

function showSettingsError(message) {
  els.settingsError.textContent = message;
  els.settingsError.hidden = message === '';
}

function fillSettings(config) {
  const llm = config?.llm ?? {};
  els.llmBaseUrl.value = typeof llm.base_url === 'string' ? llm.base_url : '';
  els.llmApiKey.value = '';
  els.llmApiKeyHint.textContent = maskHint(typeof llm.api_key === 'string' ? llm.api_key : '');
  els.llmChatModel.value = typeof llm.chat_model === 'string' ? llm.chat_model : '';
  els.llmUtilityModel.value = typeof llm.utility_model === 'string' ? llm.utility_model : '';
  showSettingsError('');
}

async function openSettings() {
  state.settings.loaded = false;
  if (!els.settingsDialog.open) {
    els.settingsDialog.showModal();
  }
  els.llmBaseUrl.focus();
  setSettingsBusy(true);
  showSettingsError('');
  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error?.message ?? '暂时读不到配置');
    }
    state.settings.loaded = true;
    fillSettings(body.config);
  } catch (err) {
    state.settings.loaded = false;
    showSettingsError(err instanceof Error && err.message ? err.message : '暂时读不到配置');
  } finally {
    setSettingsBusy(false);
  }
}

function closeSettings() {
  if (els.settingsDialog.open) {
    els.settingsDialog.close();
  }
}

async function saveSettings() {
  if (state.settings.busy || !state.settings.loaded) {
    return;
  }

  const llm = {
    base_url: els.llmBaseUrl.value.trim(),
    api_key: els.llmApiKey.value.trim(),
    chat_model: els.llmChatModel.value.trim(),
    utility_model: els.llmUtilityModel.value.trim(),
  };

  setSettingsBusy(true);
  showSettingsError('');

  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ llm }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showSettingsError(body.error?.message ?? '没能保存，请稍后再试');
      return;
    }
    fillSettings(body.config);
    state.settings.loaded = true;
    closeSettings();
    showToast('已保存，下一句就用新配置');
  } catch {
    showSettingsError('服务没有响应，请稍后再试');
  } finally {
    setSettingsBusy(false);
  }
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

let dragDepth = 0;

document.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth += 1;
  document.body.classList.add('is-dragging');
});

document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    document.body.classList.remove('is-dragging');
  }
});

document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    openImport();
    void handleFile(file);
  }
});

document.addEventListener('dragend', () => {
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
});

els.stageImport.addEventListener('click', openImport);
els.importClose.addEventListener('click', closeImport);
els.importCancel.addEventListener('click', closeImport);
els.importConfirm.addEventListener('click', () => void commitPending('new'));
els.importOverwrite.addEventListener('click', () => void commitPending('overwrite'));
els.importDialog.addEventListener('close', resetImport);
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) {
    void handleFile(file);
  }
});

els.exportClose.addEventListener('click', closeExport);
els.exportPng.addEventListener('click', () => void downloadExport('png'));
els.exportJson.addEventListener('click', () => void downloadExport('json'));
els.exportDialog.addEventListener('close', () => {
  state.exportTarget = null;
  setExportBusy(false);
});

els.deleteClose.addEventListener('click', closeDelete);
els.deleteCancel.addEventListener('click', closeDelete);
els.deleteConfirm.addEventListener('click', () => void confirmDelete());
els.deleteDialog.addEventListener('close', () => {
  state.deleteTarget = null;
  setDeleteBusy(false);
});

els.settingsOpen.addEventListener('click', () => void openSettings());
els.settingsClose.addEventListener('click', closeSettings);
els.settingsCancel.addEventListener('click', closeSettings);
els.settingsSave.addEventListener('click', () => void saveSettings());
els.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSettings();
});
els.settingsDialog.addEventListener('close', () => {
  state.settings.loaded = false;
  setSettingsBusy(false);
  showSettingsError('');
});
// 点遮罩关闭：`<dialog>` 自身的点击落在 ::backdrop 上时 event.target 就是 dialog。
// 保存中不给关，否则用户会以为没存上。
els.settingsDialog.addEventListener('click', (event) => {
  if (event.target !== els.settingsDialog || state.settings.busy) {
    return;
  }
  closeSettings();
});

els.drawerOpen.addEventListener('click', () => void openDrawer());
els.drawerClose.addEventListener('click', closeDrawer);
els.drawerRefresh.addEventListener('click', () => void loadDrawer());
els.drawerDialog.addEventListener('close', () => {
  state.drawer.seq += 1;
  state.drawer.loading = false;
});
els.drawerTabs.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const tab = event.target.closest('[role="tab"]');
  if (tab) {
    selectTab(tab.id.replace(/^tab-/, ''));
  }
});
els.drawerTabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return;
  }
  const names = ['sched', 'memory', 'today', 'usage'];
  const index = names.indexOf(state.drawer.tab);
  const next = event.key === 'ArrowRight'
    ? (index + 1) % names.length
    : (index - 1 + names.length) % names.length;
  event.preventDefault();
  selectTab(names[next], true);
});
for (const input of document.querySelectorAll('input[name="deleteScope"]')) {
  input.addEventListener('change', updateDeleteWarning);
}

els.search.addEventListener('input', renderLibrary);
els.clearSearch.addEventListener('click', () => {
  els.search.value = '';
  renderLibrary();
  els.search.focus();
});

els.libraryList.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const start = event.target.closest('[data-start]');
  if (start) {
    event.stopPropagation();
    void startCard(Number(start.dataset.start));
    return;
  }
  const exportButton = event.target.closest('[data-export]');
  if (exportButton) {
    event.stopPropagation();
    openExport(Number(exportButton.dataset.export));
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    event.stopPropagation();
    openDelete(Number(deleteButton.dataset.delete));
    return;
  }
  const card = event.target.closest('.card');
  if (card) {
    selectCard(Number(card.dataset.id));
  }
});

els.libraryList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  if (!(event.target instanceof Element)
    || event.target.closest('[data-start], [data-export], [data-delete]')) {
    return;
  }
  const card = event.target.closest('.card');
  if (card) {
    event.preventDefault();
    selectCard(Number(card.dataset.id));
  }
});

els.introStart.addEventListener('click', () => {
  if (state.selectedId !== null) {
    void startCard(state.selectedId);
  }
});

els.composerInput.addEventListener('input', () => updateComposer(currentCard()));
els.composerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});
els.composerSend.addEventListener('click', () => void sendMessage());

els.menuBtn.addEventListener('click', () => {
  if (document.body.classList.contains('rail-open')) {
    closeRail();
  } else {
    openRail();
  }
});
els.railClose.addEventListener('click', closeRail);
els.railBackdrop.addEventListener('click', closeRail);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('rail-open')) {
    closeRail();
  }
});

els.toast.addEventListener('animationend', () => {
  els.toast.classList.remove('is-visible');
  els.toast.hidden = true;
});

window.addEventListener('focus', () => {
  void loadCards();
});

/**
 * 本地日只在启动时问一次服务端：页面没有时钟，也不许自己算。
 * 跨零点后措辞会旧，但页面每次聚焦都会重新 loadCards，
 * 这里一并刷新即可，不做定时器（硬规则 1）。
 */
async function loadToday() {
  try {
    const response = await fetch('/health', { headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (body?.today) {
      state.today = body.today;
      state.yesterday = body.yesterday ?? null;
    }
  } catch {
    // 拿不到就退回只显示「M月D日」，不影响对话。
  }
}

window.addEventListener('focus', () => {
  void loadToday();
});

connectEvents();
void loadToday();
void loadCards();
