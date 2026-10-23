'use strict';

/* =====================================================================
   СИСТЕМА — поднятие уровня в реальной жизни
   Всё хранится в localStorage (память браузера на этом устройстве).
   ===================================================================== */

const SAVE_KEY = 'system-save-v1';

// Характеристики: ключ → подписи
const STATS = {
  str: { short: 'СИЛ', name: 'Сила' },
  int: { short: 'ИНТ', name: 'Интеллект' },
  vit: { short: 'ВЫН', name: 'Выносливость' },
  cha: { short: 'ХАР', name: 'Харизма' },
};

// Ранги побочных квестов: сколько опыта и очков характеристики дают
const QUEST_RANKS = {
  E: { xp: 10, stat: 1 },
  D: { xp: 25, stat: 1 },
  C: { xp: 50, stat: 2 },
  B: { xp: 100, stat: 2 },
  A: { xp: 200, stat: 3 },
  S: { xp: 400, stat: 3 },
};

const DAILY_XP = 20;        // за одно ежедневное задание
const DAILY_BONUS_XP = 50;  // бонус за весь ежедневный квест
const POINTS_PER_LEVEL = 3; // свободных очков за новый уровень

// Ранг игрока по уровню (от E до S)
const PLAYER_RANKS = [
  { min: 70, rank: 'S', title: 'Монарх теней' },
  { min: 50, rank: 'A', title: 'Элитный охотник' },
  { min: 35, rank: 'B', title: 'Опытный охотник' },
  { min: 20, rank: 'C', title: 'Охотник' },
  { min: 10, rank: 'D', title: 'Пробудившийся' },
  { min: 1,  rank: 'E', title: 'Слабейший охотник' },
];

// Штрафные задания: одно случайное выпадает при провале дня
const PENALTIES = [
  '100 приседаний',
  '50 отжиманий (можно подходами)',
  'Планка: 3 минуты суммарно',
  'Генеральная уборка комнаты: 30 минут',
  'Пробежка 3 км',
  '1 час учёбы без телефона',
];

// Ежедневные задания по умолчанию (можно менять в настройках)
const DEFAULT_DAILIES = [
  { title: 'Отжимания ×20', stat: 'str' },
  { title: 'Приседания ×30', stat: 'str' },
  { title: 'Пресс ×20', stat: 'str' },
  { title: 'Бег или быстрая ходьба 2 км', stat: 'vit' },
  { title: 'Выпить 2 литра воды', stat: 'vit' },
  { title: 'Учёба или код: 1 час', stat: 'int' },
  { title: '1 час без соцсетей', stat: 'cha' },
];

/* ---------- Мелкие помощники ---------- */

const $ = (sel) => document.querySelector(sel);

// Уникальный id для квестов
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Дата в формате ГГГГ-ММ-ДД по местному времени (шведская локаль даёт как раз такой формат)
const dayKey = (d = new Date()) => d.toLocaleDateString('sv');

// Сколько дней между двумя датами вида ГГГГ-ММ-ДД
function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
  return Math.round(ms / 86400000);
}

// Опыт, нужный для перехода с уровня level на следующий
const xpToNext = (level) => 100 + (level - 1) * 30;

const rankOf = (level) => PLAYER_RANKS.find((r) => level >= r.min);

// Экранирование текста, чтобы название квеста не сломало HTML
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Лёгкая вибрация телефона (если поддерживается)
const buzz = (p) => { if (navigator.vibrate) navigator.vibrate(p); };

/* ---------- Сохранение ---------- */

function newState() {
  return {
    v: 1,
    name: '',
    level: 1,
    xp: 0,
    freePoints: 0,
    stats: { str: 10, int: 10, vit: 10, cha: 10 },
    dailies: DEFAULT_DAILIES.map((d) => ({ id: uid(), ...d })),
    today: { date: dayKey(), done: [] },  // какие ежедневки отмечены сегодня
    side: [],                               // побочные квесты
    penalty: null,                          // активное наказание
    streak: 0,
    best: 0,
    log: [],
    notify: { on: true, morning: '09:00', evening: '21:00' }, // напоминания (только в Android-приложении)
    online: { joined: false, nick: '', secret: '' },          // онлайн-рейтинг
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return { ...newState(), ...JSON.parse(raw) };
  } catch (e) { /* битое сохранение — начинаем заново */ }
  return newState();
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* память недоступна */ }
  planNotifications();
  planSync();
}

/* ---------- Онлайн-рейтинг (Supabase через посредника на нашем сайте) ---------- */

const SITE = 'https://podnyatie-urovnya.pages.dev';
const SB_URL = 'https://jhoqjypixkilfnshonmk.supabase.co/rest/v1/';
const SB_KEY = 'sb_publishable_UtLoaxB21zedKXUD0wberQ_ozjqaE1D'; // публичный ключ: читать витрину и вызывать функции

// Запрос к базе: сначала через наш сайт (/sb/), если не вышло — напрямую в Supabase
async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const proxy = (location.hostname.endsWith('pages.dev') ? '' : SITE) + '/sb/' + path;
  try {
    const r = await fetch(proxy, opts);
    if (r.ok) return await r.json(); // await — чтобы ошибка разбора тоже ушла в catch
  } catch (e) { /* посредник недоступен — пробуем напрямую */ }
  const r = await fetch(SB_URL + path, { ...opts, headers: { ...(opts.headers || {}), apikey: SB_KEY } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Весь опыт с начала игры: сумма за пройденные уровни + текущий
const totalXp = () => 100 * (state.level - 1) + 15 * (state.level - 1) * (state.level - 2) + state.xp;

// Секретный код устройства: по нему база понимает, что ник твой
function onlineSecret() {
  if (!state.online.secret) {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    state.online.secret = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return state.online.secret;
}

async function submitProgress() {
  return api('rpc/sys_submit', {
    p_nick: state.online.nick,
    p_secret: onlineSecret(),
    p_level: state.level,
    p_total_xp: totalXp(),
    p_streak: state.streak,
    p_best: Math.max(state.best, state.streak),
  });
}

// После изменений отправляем прогресс в рейтинг (не чаще раза в 3 секунды)
let syncTimer = 0;
function planSync() {
  if (!state.online.joined) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const res = await submitProgress();
      if (res === 'taken') {
        state.online.joined = false;
        save(); render();
        topMsg('Твой ник в рейтинге занят с другого устройства. Выбери новый.', true);
      }
    } catch (e) { /* нет интернета — отправим при следующем изменении */ }
  }, 3000);
}

function topMsg(text, bad = false) {
  const el = $('#top-msg');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

let topSort = 'total_xp';

async function loadTop() {
  const list = $('#top-list');
  list.innerHTML = '<li class="muted small-text">Загрузка…</li>';
  try {
    const rows = await api(`sys_leaderboard?select=nick,level,total_xp,streak,best&order=${topSort}.desc,total_xp.desc&limit=100`);
    const me = state.online.joined ? state.online.nick.toLowerCase() : null;
    let place = '100+';
    list.innerHTML = rows.map((r, i) => {
      const mine = me && r.nick.toLowerCase() === me;
      if (mine) place = i + 1;
      const val = topSort === 'best' ? `${r.best} дн.` : `${r.total_xp} XP`;
      return `<li class="top-row ${mine ? 'me' : ''}">
        <span class="top-place">${i + 1}</span>
        <span class="rank">${rankOf(r.level).rank}</span>
        <span class="top-nick">${esc(r.nick)}<small>Ур. ${r.level} · серия ${r.streak}</small></span>
        <span class="top-val">${val}</span>
      </li>`;
    }).join('') || '<li class="muted small-text">Пока никого. Стань первым охотником в рейтинге!</li>';
    $('#top-place').textContent = place;
  } catch (e) {
    list.innerHTML = '<li class="muted small-text">Не удалось загрузить рейтинг. Проверь интернет и нажми «Обновить».</li>';
  }
}

async function joinTop(nick) {
  nick = nick.trim();
  if (!nick) return;
  topMsg('Проверяю ник…');
  try {
    const check = await api('rpc/sys_check_nick', { p_nick: nick, p_secret: onlineSecret() });
    if (check === 'taken') { topMsg('Этот ник уже занят другим охотником. Выбери другой.', true); return; }
    state.online.nick = nick;
    const res = await submitProgress();
    if (res !== 'new' && res !== 'ok') { topMsg('Система отклонила данные (' + res + ').', true); return; }
    state.online.joined = true;
    addLog(`Вход в рейтинг охотников под ником ${nick}`, 'good');
    save(); render();
    topMsg('');
    toast('Ты в рейтинге охотников!', 'gold');
    loadTop();
  } catch (e) {
    topMsg('Нет связи с Системой. Проверь интернет.', true);
  }
}

async function leaveTop() {
  try { await api('rpc/sys_leave', { p_nick: state.online.nick, p_secret: onlineSecret() }); } catch (e) { /* не страшно */ }
  state.online.joined = false;
  save(); render();
  loadTop();
}

/* ---------- Напоминания (Android-приложение через Capacitor) ---------- */

// В APK Capacitor сам добавляет объект window.Capacitor; на сайте его нет
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const Notif = isNative ? window.Capacitor.Plugins.LocalNotifications : null;

let notifyTimer = 0;

// Пересобираем расписание не на каждый клик, а через полсекунды после последнего изменения
function planNotifications() {
  if (!Notif) return;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(rescheduleNotifications, 500);
}

// Дата: через dayOffset дней в указанное время "ЧЧ:ММ"
function atTime(dayOffset, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

async function rescheduleNotifications() {
  try {
    // Сначала убираем всё запланированное раньше
    const pending = await Notif.getPending();
    if (pending.notifications.length) {
      await Notif.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
    const n = state.notify;
    if (!n.on || !state.dailies.length) return;

    const now = new Date();
    const list = [];
    // Планируем на неделю вперёд: если приложение не открывать, напоминания всё равно придут
    for (let i = 0; i < 7; i++) {
      const morning = atTime(i, n.morning);
      if (morning > now) {
        list.push({
          id: 100 + i,
          title: '[СИСТЕМА] Ежедневный квест',
          body: 'Поступил новый ежедневный квест: «Подготовка к тому, чтобы стать сильнее».',
          schedule: { at: morning, allowWhileIdle: true },
        });
      }
      const evening = atTime(i, n.evening);
      // Сегодня предупреждаем, только если квест ещё не закрыт
      if (evening > now && !(i === 0 && dailyAllDone())) {
        const left = state.dailies.filter((d) => !state.today.done.includes(d.id)).length;
        list.push({
          id: 200 + i,
          title: '[СИСТЕМА] Предупреждение',
          body: i === 0
            ? `Ежедневный квест не выполнен (осталось заданий: ${left}). В полночь начнётся наказание.`
            : 'Ежедневный квест не выполнен. В полночь начнётся наказание.',
          schedule: { at: evening, allowWhileIdle: true },
        });
      }
    }
    if (list.length) await Notif.schedule({ notifications: list });
  } catch (e) {
    console.warn('Напоминания не запланированы', e);
  }
}

// Включение: на Android 13+ нужно разрешение пользователя
async function enableNotifications() {
  if (!Notif) return false;
  try {
    const p = await Notif.requestPermissions();
    if (p.display !== 'granted') {
      toast('Без разрешения на уведомления напоминаний не будет.', 'bad');
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- Журнал и уведомления ---------- */

function addLog(text, kind = '') {
  state.log.unshift({ t: Date.now(), text, kind });
  state.log = state.log.slice(0, 200); // храним последние 200 записей
}

function toast(html, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = '<b>[СИСТЕМА]</b> ' + html;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

/* ---------- Опыт и уровни ---------- */

function gainXp(amount) {
  state.xp += amount;
  let ups = 0;
  // Может хватить сразу на несколько уровней
  while (state.xp >= xpToNext(state.level)) {
    state.xp -= xpToNext(state.level);
    state.level++;
    state.freePoints += POINTS_PER_LEVEL;
    ups++;
  }
  if (ups) {
    const oldRank = rankOf(state.level - ups).rank;
    const r = rankOf(state.level);
    addLog(`Уровень повышен до ${state.level}`, 'good');
    buzz([60, 40, 120]);
    let extra = '';
    if (r.rank !== oldRank) {
      extra = `<p>Ранг повышен: <b class="rank">${r.rank}</b>. Новый титул: «${esc(r.title)}».</p>`;
      addLog(`Новый ранг: ${r.rank}`, 'good');
    }
    showModal('УРОВЕНЬ ПОВЫШЕН', `
      <div class="big">LEVEL UP!</div>
      <p style="text-align:center">Уровень <b>${state.level}</b></p>
      ${extra}
      <p>Получено свободных очков: <b>${POINTS_PER_LEVEL * ups}</b>. Распредели их на экране статуса.</p>`,
      [{ text: 'Принять' }]);
  }
}

// Потеря опыта при наказании: уровень не падает, опыт не уходит ниже нуля
function loseXp(amount) {
  const lost = Math.min(amount, state.xp);
  state.xp -= lost;
  return lost;
}

/* ---------- Ежедневные квесты ---------- */

const dailyAllDone = () =>
  state.dailies.length > 0 && state.dailies.every((d) => state.today.done.includes(d.id));

function toggleDaily(id) {
  if (state.penalty) return;
  const d = state.dailies.find((x) => x.id === id);
  if (!d) return;
  const done = state.today.done;
  const wasAll = dailyAllDone();

  if (done.includes(id)) {
    // Снять отметку: забираем то, что выдали
    state.today.done = done.filter((x) => x !== id);
    loseXp(DAILY_XP);
    state.stats[d.stat] = Math.max(1, state.stats[d.stat] - 1);
    if (wasAll) {
      loseXp(DAILY_BONUS_XP);
      state.freePoints = Math.max(0, state.freePoints - 1);
    }
  } else {
    done.push(id);
    state.stats[d.stat]++;
    toast(`Задание выполнено. +${DAILY_XP} XP, ${STATS[d.stat].short} +1`);
    buzz(30);
    gainXp(DAILY_XP);
    if (dailyAllDone()) {
      state.freePoints++;
      addLog('Ежедневный квест выполнен полностью', 'good');
      toast(`Ежедневный квест выполнен! Награда: +${DAILY_BONUS_XP} XP и 1 свободное очко`, 'gold');
      gainXp(DAILY_BONUS_XP);
    }
  }
  save();
  render();
}

/* ---------- Смена дня и наказание ---------- */

function checkNewDay() {
  const today = dayKey();
  if (state.today.date === today) return;

  const gap = daysBetween(state.today.date, today);
  const finished = dailyAllDone();

  if (finished && gap === 1) {
    // Вчера всё сделал — серия растёт
    state.streak++;
    state.best = Math.max(state.best, state.streak);
  } else if (state.dailies.length > 0) {
    // Не сделал вчера (или пропустил целые дни, не открывая приложение)
    const missedDays = finished ? gap - 1 : gap;
    const loss = loseXp(missedDays * DAILY_BONUS_XP);
    state.streak = 0;
    if (!state.penalty) {
      state.penalty = {
        task: PENALTIES[Math.floor(Math.random() * PENALTIES.length)],
        loss,
        days: missedDays,
      };
    }
    addLog(`Провал ежедневного квеста (дней: ${missedDays}). Потеряно ${loss} XP`, 'bad');
  }

  state.today = { date: today, done: [] };
  save();
}

function completePenalty() {
  if (!state.penalty) return;
  addLog(`Наказание отбыто: ${state.penalty.task}`, 'good');
  state.penalty = null;
  save();
  buzz([40, 30, 40]);
  toast('Наказание отбыто. Доступ к квестам восстановлен.', 'gold');
  render();
}

// Кнопка «удерживай 2 секунды» — чтобы не нажать случайно
function setupHoldButton(btn, ms, onDone) {
  const fill = btn.querySelector('.hold-fill');
  let start = 0, raf = 0;

  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / ms);
    fill.style.width = p * 100 + '%';
    if (p >= 1) { stop(); onDone(); return; }
    raf = requestAnimationFrame(tick);
  };
  const begin = (e) => { e.preventDefault(); start = performance.now(); raf = requestAnimationFrame(tick); };
  const stop = () => { cancelAnimationFrame(raf); fill.style.width = '0'; };

  btn.addEventListener('pointerdown', begin);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  // С клавиатуры: держим Enter или пробел
  btn.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) begin(e); });
  btn.addEventListener('keyup', stop);
}

/* ---------- Побочные квесты ---------- */

function addSide(title, stat, rank) {
  state.side.unshift({ id: uid(), title, stat, rank, done: false });
  addLog(`Новый побочный квест [${rank}]: ${title}`);
  save();
  render();
}

function toggleSide(id) {
  if (state.penalty) return;
  const q = state.side.find((x) => x.id === id);
  if (!q) return;
  const r = QUEST_RANKS[q.rank];
  q.done = !q.done;
  if (q.done) {
    state.stats[q.stat] += r.stat;
    addLog(`Квест [${q.rank}] выполнен: ${q.title}`, 'good');
    toast(`Квест выполнен. +${r.xp} XP, ${STATS[q.stat].short} +${r.stat}`);
    buzz(30);
    gainXp(r.xp);
  } else {
    state.stats[q.stat] = Math.max(1, state.stats[q.stat] - r.stat);
    loseXp(r.xp);
  }
  save();
  render();
}

function deleteSide(id) {
  state.side = state.side.filter((x) => x.id !== id);
  save();
  render();
}

/* ---------- Модальное окно ---------- */

function showModal(title, bodyHtml, buttons) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  const box = $('#modal-buttons');
  box.innerHTML = '';
  buttons.forEach((b) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn' + (b.danger ? ' danger' : '');
    el.textContent = b.text;
    el.onclick = () => {
      if (b.onClick && b.onClick() === false) return; // false — не закрывать окно
      $('#modal').hidden = true;
    };
    box.appendChild(el);
  });
  $('#modal').hidden = false;
  box.querySelector('button')?.focus();
}

// Первое знакомство с Системой
function showAwakening() {
  showModal('УВЕДОМЛЕНИЕ', `
    <p>Вы выполнили условия скрытого квеста «Мужество слабого».</p>
    <p>Вы получили право стать <b>Игроком</b>. Принять?</p>
    <label class="field">Как к тебе обращаться?
      <input id="awake-name" type="text" maxlength="24" placeholder="Имя охотника">
    </label>`,
    [{
      text: 'Принять',
      onClick: () => {
        const name = $('#awake-name').value.trim();
        if (!name) { $('#awake-name').focus(); return false; }
        state.name = name;
        addLog(`${name} стал Игроком`, 'good');
        save();
        render();
        toast('Добро пожаловать, Игрок.', 'gold');
        // В приложении сразу просим разрешение на напоминания
        if (isNative && state.notify.on) {
          enableNotifications().then((ok) => { if (!ok) { state.notify.on = false; save(); render(); } });
        }
      },
    }]);
}

/* ---------- Отрисовка ---------- */

function statOptions(sel) {
  sel.innerHTML = Object.entries(STATS)
    .map(([k, s]) => `<option value="${k}">${s.short} · ${s.name}</option>`).join('');
}

function render() {
  const r = rankOf(state.level);
  const need = xpToNext(state.level);

  // Статус
  $('#st-level').textContent = state.level;
  $('#st-name').textContent = state.name || '—';
  $('#st-rank').textContent = r.rank;
  $('#st-title').textContent = r.title;
  $('#st-streak').textContent = state.streak;
  $('#st-best').textContent = state.best;
  $('#st-xp').textContent = state.xp;
  $('#st-xpnext').textContent = need;
  $('#st-xpfill').style.width = (state.xp / need) * 100 + '%';

  $('#st-stats').innerHTML = Object.entries(STATS).map(([k, s]) => `
    <div class="stat">
      <div class="stat-name"><b>${s.short}</b>${s.name}</div>
      <div><span class="stat-val">${state.stats[k]}</span>${state.freePoints > 0
        ? `<button class="stat-plus" data-add="${k}" type="button" aria-label="Добавить очко: ${s.name}">+</button>` : ''}</div>
    </div>`).join('');
  $('#st-free').textContent = state.freePoints > 0 ? `Свободных очков: ${state.freePoints}` : '';

  const doneCount = state.dailies.filter((d) => state.today.done.includes(d.id)).length;
  $('#st-daily').textContent = `${doneCount}/${state.dailies.length}`;

  // Значок на вкладке «Квесты»: сколько ежедневок осталось
  const left = state.dailies.length - doneCount;
  const badge = $('#tab-badge');
  badge.hidden = left === 0;
  badge.textContent = left;

  // Ежедневки
  $('#daily-list').innerHTML = state.dailies.map((d) => {
    const done = state.today.done.includes(d.id);
    return `<li class="quest ${done ? 'done' : ''}" data-daily="${d.id}" role="checkbox" aria-checked="${done}" tabindex="0">
      <span class="check">${done ? '✓' : ''}</span>
      <div class="q-body">
        <div class="q-title">${esc(d.title)}</div>
        <div class="q-meta">${STATS[d.stat].short} +1 · +${DAILY_XP} XP</div>
      </div>
    </li>`;
  }).join('') || '<li class="muted">Добавь задания в настройках.</li>';

  // Побочные: сначала невыполненные
  const side = [...state.side].sort((a, b) => a.done - b.done);
  $('#side-list').innerHTML = side.map((q) => {
    const rr = QUEST_RANKS[q.rank];
    return `<li class="quest ${q.done ? 'done' : ''}" data-side="${q.id}" role="checkbox" aria-checked="${q.done}" tabindex="0">
      <span class="check">${q.done ? '✓' : ''}</span>
      <div class="q-body">
        <div class="q-title">${esc(q.title)}</div>
        <div class="q-meta"><span class="q-rank">${q.rank}</span> · ${STATS[q.stat].short} +${rr.stat} · +${rr.xp} XP</div>
      </div>
      <button class="q-del" data-del="${q.id}" type="button" aria-label="Удалить квест">✕</button>
    </li>`;
  }).join('') || '<li class="muted small-text">Побочных квестов нет. Добавь что-нибудь из реальной жизни: зачёт, проект, дело.</li>';

  // Журнал
  $('#log-list').innerHTML = state.log.map((l) => `
    <li class="${l.kind}"><time>${new Date(l.t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>${esc(l.text)}</li>`)
    .join('') || '<li class="muted">Пока пусто.</li>';

  // Настройки
  if (document.activeElement !== $('#set-name')) $('#set-name').value = state.name;
  $('#set-dailies').innerHTML = state.dailies.map((d) => `
    <li><span>${esc(d.title)} <span class="muted">· ${STATS[d.stat].short}</span></span>
      <button class="q-del" data-deldaily="${d.id}" type="button" aria-label="Удалить задание">✕</button></li>`).join('');

  // Рейтинг
  $('#top-join').hidden = state.online.joined;
  $('#top-me').hidden = !state.online.joined;
  $('#top-mynick').textContent = state.online.nick;
  if (!$('#top-nick').value && document.activeElement !== $('#top-nick')) $('#top-nick').value = state.name;

  // Напоминания
  $('#notify-box').hidden = !isNative;
  $('#nt-on').checked = state.notify.on;
  $('#nt-morning').value = state.notify.morning;
  $('#nt-evening').value = state.notify.evening;

  // Штрафная зона
  const p = state.penalty;
  $('#penalty').hidden = !p;
  if (p) {
    $('#penalty-task').textContent = p.task;
    $('#penalty-loss').textContent = `Пропущено дней: ${p.days}. Потеряно опыта: ${p.loss} XP. Серия обнулена.`;
  }
}

// Таймер до полуночи
function updateTimers() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const s = Math.floor((midnight - now) / 1000);
  const txt = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
  document.querySelectorAll('[data-timer]').forEach((el) => { el.textContent = txt; });

  // Наступила полночь, пока приложение открыто
  if (state.today.date !== dayKey()) { checkNewDay(); render(); }
}

/* ---------- Обработчики ---------- */

// Вкладки
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.screen').forEach((s) =>
      s.classList.toggle('active', s.id === 'screen-' + tab.dataset.screen));
    window.scrollTo(0, 0);
    if (tab.dataset.screen === 'top') loadTop();
  });
});

$('#top-join').addEventListener('submit', (e) => { e.preventDefault(); joinTop($('#top-nick').value); });
$('#btn-leave').addEventListener('click', leaveTop);
$('#btn-top-refresh').addEventListener('click', loadTop);
document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => {
    topSort = b.dataset.sort;
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('active', x === b));
    loadTop();
  });
});

// Клики по спискам (делегирование: один обработчик на весь документ)
document.addEventListener('click', (e) => {
  const t = e.target;
  const del = t.closest('[data-del]');
  if (del) { deleteSide(del.dataset.del); return; }
  const delDaily = t.closest('[data-deldaily]');
  if (delDaily) {
    state.dailies = state.dailies.filter((d) => d.id !== delDaily.dataset.deldaily);
    save(); render(); return;
  }
  const plus = t.closest('[data-add]');
  if (plus && state.freePoints > 0) {
    state.stats[plus.dataset.add]++;
    state.freePoints--;
    save(); render(); return;
  }
  const daily = t.closest('[data-daily]');
  if (daily) { toggleDaily(daily.dataset.daily); return; }
  const side = t.closest('[data-side]');
  if (side) toggleSide(side.dataset.side);
});

// Квест можно отметить с клавиатуры пробелом или Enter
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  const q = e.target.closest?.('[data-daily], [data-side]');
  if (!q || e.target !== q) return;
  e.preventDefault();
  q.click();
});

$('#side-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#side-title').value.trim();
  if (!title) return;
  addSide(title, $('#side-stat').value, $('#side-rank').value);
  $('#side-title').value = '';
});

$('#daily-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#daily-title').value.trim();
  if (!title) return;
  state.dailies.push({ id: uid(), title, stat: $('#daily-stat').value });
  $('#daily-title').value = '';
  save(); render();
});

$('#set-name').addEventListener('change', (e) => {
  state.name = e.target.value.trim() || state.name;
  save(); render();
});

$('#nt-on').addEventListener('change', async (e) => {
  const on = e.target.checked && await enableNotifications();
  state.notify.on = on;
  save(); render();
  if (on) toast('Напоминания включены.', 'gold');
});

['morning', 'evening'].forEach((k) => {
  $('#nt-' + k).addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.notify[k] = e.target.value;
    save();
  });
});

// Резервная копия в файл
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `система-${dayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data.level !== 'number' || !data.stats) throw new Error('не тот файл');
    state = { ...newState(), ...data };
    checkNewDay();
    save(); render();
    toast('Копия загружена.', 'gold');
  } catch (err) {
    toast('Не удалось прочитать файл копии.', 'bad');
  }
  e.target.value = '';
});

$('#btn-reset').addEventListener('click', () => {
  showModal('ВНИМАНИЕ', '<p>Весь прогресс будет стёрт: уровень, характеристики, квесты, журнал. Отменить это нельзя.</p>', [
    { text: 'Отмена' },
    {
      text: 'Стереть', danger: true,
      onClick: () => { state = newState(); save(); render(); setTimeout(showAwakening, 50); },
    },
  ]);
});

setupHoldButton($('#penalty-done'), 2000, completePenalty);

/* ---------- Запуск ---------- */

statOptions($('#side-stat'));
statOptions($('#daily-stat'));
$('#side-rank').innerHTML = Object.entries(QUEST_RANKS)
  .map(([k, r]) => `<option value="${k}">Ранг ${k} · ${r.xp} XP</option>`).join('');

checkNewDay();
render();
updateTimers();
setInterval(updateTimers, 1000);

if (!state.name) showAwakening();

// Проверяем смену дня, когда приложение снова открыли из фона
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { checkNewDay(); render(); }
});

/* ---------- Установка на главный экран ---------- */

// Уже открыто как приложение — блок установки не нужен
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let installEvent = null;

if (!standalone) {
  // Android и ПК (Chrome, Edge, Яндекс): браузер сам даёт событие, по нему показываем кнопку
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    $('#install-box').hidden = false;
    $('#btn-install').hidden = false;
  });
  // iPhone: кнопки установки нет, показываем подсказку
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('#install-box').hidden = false;
    $('#install-text').textContent = 'В Safari нажми «Поделиться» (квадрат со стрелкой) → «На экран "Домой"».';
  }
}

$('#btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#install-box').hidden = true;
});

// Service worker — чтобы приложение работало без интернета и ставилось на телефон
// (в APK файлы и так лежат внутри приложения, там он не нужен)
planNotifications();
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isNative) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
