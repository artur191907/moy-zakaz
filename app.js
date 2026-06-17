/* =========================================================================
   «Мой заказ» — официантская система для суши-бистро (Telegram Mini App).
   Логика в духе iiko:
     • Столы — реальные столы зала, их можно переставлять в нужном порядке.
     • Меню — общее меню заведения (роллы, суши, сеты, горячее, напитки…).
     • Под каждым столом — свой «открытый счёт» (заказ), который сохраняется.
     • Закрытие стола переносит заказ в историю и освобождает стол.
   Чистый ES6+, без фреймворков. Комментарии на русском.
   ========================================================================= */

'use strict';

/* ----------------------------- УТИЛИТЫ ----------------------------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Доступные цвета столов
const COLORS = ['c1','c2','c3','c4','c5','c6','c7','c8'];
// Набор модификаторов блюда (как модификаторы в iiko)
const MODIFIERS = ['Без васаби', 'Без имбиря', 'Острее', 'С собой'];
// Статусы позиции в заказе: новое → на кухне → подано
const STATUS = {
  new:    { label: '🆕 Новое',   cls: 'is-new' },
  sent:   { label: '🍳 На кухне', cls: 'is-sent' },
  served: { label: '✅ Подано',  cls: 'is-served' },
};
const STATUS_SEQ = ['new', 'sent', 'served'];

/* --------------------------- TELEGRAM WEBAPP --------------------------- */
const TG = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const tg = {
  api: TG,
  init() {
    if (!TG) return;
    try { TG.ready(); } catch (e) {}
    try { TG.expand(); } catch (e) {}
    try { TG.disableVerticalSwipes && TG.disableVerticalSwipes(); } catch (e) {}
    this.applyTheme();
    TG.onEvent && TG.onEvent('themeChanged', () => this.applyTheme());
  },
  applyTheme() {
    if (!TG || !TG.themeParams) return;
    const p = TG.themeParams;
    const root = document.documentElement.style;
    const set = (v, val) => { if (val) root.setProperty(v, val); };
    set('--bg', p.bg_color);
    set('--text', p.text_color);
    set('--hint', p.hint_color || p.subtitle_text_color);
    set('--link', p.link_color || p.accent_text_color);
    set('--button', p.button_color);
    set('--button-text', p.button_text_color);
    set('--secondary-bg', p.secondary_bg_color || p.section_bg_color);
    set('--section-bg', p.section_bg_color || p.bg_color);
    set('--header-bg', p.header_bg_color || p.button_color);
    set('--destructive', p.destructive_text_color);
    document.body.style.background = p.secondary_bg_color || p.bg_color || '';
  },
  setHeaderColor(color) { if (TG && TG.setHeaderColor) { try { TG.setHeaderColor(color); } catch (e) {} } },
  mainButton(text, onClick) {
    if (!TG || !TG.MainButton) return;
    const mb = TG.MainButton;
    mb.setText(text);
    mb.offClick(this._mbHandler);
    this._mbHandler = () => onClick();
    mb.onClick(this._mbHandler);
    mb.show();
  },
  hideMainButton() { if (TG && TG.MainButton) TG.MainButton.hide(); },
  showBackButton() { if (TG && TG.BackButton) TG.BackButton.show(); },
  hideBackButton() { if (TG && TG.BackButton) TG.BackButton.hide(); },
  onBack(fn) { if (TG && TG.BackButton) TG.BackButton.onClick(fn); },
  haptic(type = 'light') {
    if (!TG || !TG.HapticFeedback) return;
    try {
      if (['success','error','warning'].includes(type)) TG.HapticFeedback.notificationOccurred(type);
      else TG.HapticFeedback.impactOccurred(type);
    } catch (e) {}
  },
  confirm(message, cb) {
    if (TG && TG.showConfirm) TG.showConfirm(message, (ok) => cb(ok));
    else cb(window.confirm(message));
  },
};

/* ----------------------------- ДАННЫЕ ----------------------------- */
const STORE_KEY = 'myorder_db_v2';   // v2 — ресторанная модель

const DB = {
  state: null,

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.version === 3) { this.state = data; return; }
      }
    } catch (e) {}
    this.state = this.seed();
    this.save();
  },
  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); }
    catch (e) { toast('Не удалось сохранить — нет места в хранилище'); }
  },
  reset() { this.state = this.seed(); this.save(); },

  // Заводские данные: меню суши-бистро + столы
  seed() {
    // Фабрики
    // dish(эмодзи, название, цена, граммовка)
    const dish = (emoji, name, price, weight) => ({ id: uid(), emoji, name, price, weight });
    const sec  = (name, items) => ({ id: uid(), name, items });
    const tbl  = (name, emoji, color) => ({ id: uid(), name, emoji, color, order: [] });

    return {
      version: 3,
      settings: { currency: '₽' },
      // РЕАЛЬНОЕ МЕНЮ «СУШИ БИСТРО» (по скриншотам Яндекс.Еды). Всё редактируется в приложении.
      menu: {
        sections: [
          sec('Авторские роллы', [
            dish('🍣', 'Тамаки Сан', 1090, '320 г'),
            dish('🍣', 'Фудзи', 1090, '345 г'),
            dish('🐉', 'Шёлковый Дракон', 1090, '345 г'),
            dish('🍣', 'Икура Сан', 1190, '265 г'),
            dish('🍣', 'Шан цзун', 999, '327 г'),
            dish('🍣', 'Лю кан', 999, '380 г'),
            dish('🍣', 'Райден', 999, '354 г'),
            dish('🍣', 'Саб-зиро', 999, '362 г'),
            dish('🦂', 'Скорпион', 999, '367 г'),
            dish('🌋', 'Вулкан', 1090, '284 г'),
            dish('🍣', 'Якудза', 999, '315 г'),
            dish('🍤', 'Фудзи эби', 999, '345 г'),
          ]),
          sec('Рамён', [
            dish('🍜', 'Рамен Том Ям', 555, '700 г'),
            dish('🍜', 'Рамен мисо морепродукты', 555, '700 г'),
            dish('🍜', 'Рамен с курицей', 555, '700 г'),
            dish('🍜', 'Рамен с говядиной', 555, '700 г'),
            dish('🍜', 'Рамен с креветками', 555, '700 г'),
            dish('🍜', 'Рамен с лососем', 555, '700 г'),
            dish('🍜', 'Рамен сырный', 555, '700 г'),
            dish('🥟', 'Рамэн Гёдза с говядиной', 555, '700 г'),
          ]),
          sec('Сеты', [
            dish('🍱', 'Корпоратив L', 9500, '4,6 кг'),
            dish('🍱', 'Корпоратив M', 6400, '2,3 кг'),
            dish('🍱', 'Корпоратив S', 3200, '1,15 кг'),
            dish('❤️', 'Romantic', 3200, '1,12 кг'),
            dish('🍱', 'Феймос', 2450, '869 г'),
            dish('🍱', 'Филадельфия', 2750, '885 г'),
            dish('🍱', 'Гурман', 3200, '1,09 кг'),
            dish('🌶️', 'Хот', 3100, '1,01 кг'),
            dish('🍱', 'Фирма', 4300, '1,5 кг'),
            dish('🍱', 'Мажор', 5300, '1,65 кг'),
            dish('🍱', 'Мини', 2000, '700 г'),
            dish('🍱', 'Сет Куба', 2320, '975 г'),
          ]),
          sec('Салаты', [
            dish('🥗', 'Цезарь с креветками', 650, '310 г'),
            dish('🥗', 'Салат Азия с баклажанами', 555, '350 г'),
            dish('🥗', 'Салат с говядиной', 790, '330 г'),
            dish('🥗', 'Салат с креветками и манго', 670, '140 г'),
            dish('🥗', 'Цезарь с курицей', 590, '310 г'),
            dish('🥗', 'Цезарь с лососем', 650, '310 г'),
            dish('🥗', 'Азиатский салат с говядиной', 750, '140 г'),
            dish('🥗', 'Салат с морепродуктами', 950, '450 г'),
          ]),
          sec('Закуски', [
            dish('🍟', 'Картофель фри', 250, '180 г'),
            dish('🦪', 'Мидии в соусе Блю Чиз', 790, '600 г'),
            dish('🧀', 'Сырные палочки', 390, '140 г'),
            dish('🍣', 'Сашими Лосось', 650, '80 г'),
            dish('🍣', 'Сашими Тунец', 650, '90 г'),
            dish('🥩', 'Тартар из говядины', 690, '150 г'),
            dish('🥟', 'Гёдза', 555, '120 г'),
            dish('🍆', 'Баклажан темпура', 490, '180 г'),
            dish('🍤', 'Креветки в миндале', 555, '150 г'),
            dish('🍤', 'Креветки темпура', 555, '150 г'),
            dish('🍤', 'Креветки в сухарях панко', 555, '150 г'),
            dish('🍣', 'Тартар лосось', 777, '150 г'),
            dish('🦪', 'Мидии запеченные спайси краб', 555, '120 г'),
            dish('🦪', 'Мидии запеченные с соусом лава', 555, '120 г'),
            dish('🦪', 'Мидии запеченные под сырным соусом', 555, '120 г'),
          ]),
          sec('Поке', [
            dish('🥗', 'Поке Веган', 750, '323 г'),
            dish('🍚', 'Поке Лосось', 750, '365 г'),
            dish('🍚', 'Поке креветки панко', 750, '365 г'),
            dish('🍚', 'Поке гурман', 790, '365 г'),
            dish('🍚', 'Поке Креветка', 750, '365 г'),
          ]),
          sec('Супы', [
            dish('🍲', 'Кукси с говядиной', 555, '680 г'),
            dish('🍲', 'Том ям с морепродуктами', 730, '555 г'),
            dish('🍲', 'Том ям с креветками', 690, '520 г'),
            dish('🍲', 'Том ям с курицей', 670, '520 г'),
          ]),
          sec('Суши', [
            dish('🍣', 'Гункан Лосось', 200, '40 г'),
            dish('🍣', 'Гункан Креветка', 200, '40 г'),
            dish('🍣', 'Гункан Угорь', 200, '40 г'),
            dish('🍙', 'Онигири темпура креветка', 490, '210 г'),
            dish('🍙', 'Онигири классик лосось', 333, '150 г'),
            dish('🍙', 'Онигири темпура лосось', 490, '210 г'),
            dish('🍤', 'Суши с креветкой', 200, '30 г'),
            dish('🍣', 'Суши с лососем', 200, '35 г'),
            dish('🍙', 'Онигири классик Тунец', 333, '150 г'),
            dish('🍙', 'Онигири темпура угорь', 490, '210 г'),
            dish('🍙', 'Онигири классик угорь', 333, '150 г'),
            dish('🍙', 'Онигири классик креветка', 333, '150 г'),
            dish('🍣', 'Суши с лососем и авокадо', 200, '32 г'),
          ]),
          sec('Роллы', [
            dish('🥑', 'Мини-ролл с авокадо', 420, '140 г'),
            dish('🥒', 'Мини-ролл с огурцом', 350, '165 г'),
            dish('🍣', 'Мини-ролл с лососем', 490, '140 г'),
            dish('🍤', 'Мини-ролл с креветкой', 480, '140 г'),
            dish('🍣', 'Мини ролл с тунцом', 480, '150 г'),
            dish('🍣', 'Мини-ролл с угрём', 490, '145 г'),
            dish('🍣', 'Канада', 820, '300 г'),
            dish('🍣', 'Кога', 750, '293 г'),
            dish('🔥', 'Абури лосось', 777, '305 г'),
            dish('🍣', 'Майами', 830, '291 г'),
            dish('🍣', 'Фирменный', 850, '295 г'),
            dish('🍤', 'Эби ролл', 790, '275 г'),
            dish('🍣', 'Делюкс', 990, '271 г'),
            dish('🍣', 'Масаго', 820, '269 г'),
            dish('🍣', 'Томаго', 690, '270 г'),
            dish('🍣', 'Шатен', 840, '253 г'),
            dish('🍣', 'Тартар с угрем', 820, '278 г'),
            dish('🐉', 'Зеленый дракон', 830, '258 г'),
            dish('🍣', 'Филадельфия классик', 850, '300 г'),
            dish('🍣', 'Филадельфия Лайт', 890, '300 г'),
            dish('🥑', 'Филадельфия с авокадо', 890, '300 г'),
            dish('🍣', 'Калифорния', 770, '283 г'),
            dish('🍣', 'Калифорния с лососем', 830, '265 г'),
            dish('🍣', 'Блек Джек', 840, '280 г'),
            dish('🍣', 'Сегун', 770, '295 г'),
            dish('🍣', 'Сенсей', 760, '283 г'),
          ]),
          sec('Горячие роллы', [
            dish('🔥', 'Император', 750, '245 г'),
            dish('🔥', 'Сливочный унаги', 750, '250 г'),
            dish('🔥', 'Калифорния темпура', 750, '250 г'),
            dish('🍤', 'Эби темпура', 750, '245 г'),
            dish('🔥', 'Самурай', 750, '280 г'),
            dish('🌶️', 'Спайси-темпура', 750, '255 г'),
          ]),
          sec('Запечённые роллы', [
            dish('🔥', 'Унаги Делишес', 750, '237 г'),
            dish('🔥', 'Хитатцу', 750, '230 г'),
            dish('🦀', 'Тёплый с крабом', 750, '268 г'),
            dish('🧀', 'Чиз Салмон', 750, '240 г'),
            dish('🔥', 'Тёплый с лососем', 750, '265 г'),
            dish('🍤', 'Тёплый с креветкой', 750, '265 г'),
          ]),
          sec('Новинка', [
            dish('🍔', 'Суши-бургер Лосось', 555, '265 г'),
            dish('🍔', 'Суши-бургер Тунец', 555, '265 г'),
            dish('🍔', 'Суши-бургер креветка-угорь', 555, '265 г'),
            dish('🌭', 'Ролл-дог лосось-угорь', 690, '290 г'),
            dish('🌭', 'Ролл-дог лосось-краб', 690, '290 г'),
            dish('🌭', 'Ролл-дог креветка', 690, '290 г'),
          ]),
          sec('Кондитерские изделия', [
            dish('🍰', 'Малибу', 450, '200 г'),
            dish('🍰', 'Минари', 450, '200 г'),
          ]),
          sec('Напитки', [
            dish('🥤', 'Coca-Cola', 350, '330 мл'),
            dish('🥤', 'Coca-Cola Zero', 350, '330 мл'),
            dish('🥤', 'Sprite', 350, '330 мл'),
            dish('🥤', 'Fanta', 350, '330 мл'),
            dish('🍺', 'Пивной напиток Corona Cero б/а', 450, '330 мл'),
            dish('🍺', 'Пиво б/а светлое Stella Artois', 350, '440 мл'),
            dish('🍺', 'Пиво б/а Hoegaarden', 390, '440 мл'),
            dish('💧', 'Вода Легенда Байкала газ.', 350, '500 мл'),
            dish('💧', 'Вода Легенда Байкала без газа', 350, '500 мл'),
          ]),
          sec('Холодные напитки', [
            dish('🧃', 'Свежевыжатый fresh', 500, '300 мл'),
            dish('🍹', 'Sunrise', 555, '500 мл'),
            dish('🍹', 'Sunset', 555, '500 мл'),
            dish('🍹', 'Grinch', 555, '500 мл'),
            dish('🍹', 'Mommy', 555, '500 мл'),
            dish('💧', 'Water Passion', 555, '500 мл'),
            dish('🍸', 'Mojito', 470, '500 мл'),
            dish('🥤', 'Смузи Pink', 530, '330 мл'),
            dish('🫐', 'Смузи Blueberry', 530, '300 мл'),
            dish('🍓', 'Смузи Love', 530, '300 мл'),
            dish('🥭', 'Смузи Jungle', 530, '300 мл'),
            dish('🍍', 'Смузи Tropic', 530, '300 мл'),
            dish('🥝', 'Смузи Kiwi-mint', 530, '300 мл'),
          ]),
        ],
      },
      // СТОЛЫ зала (можно переставлять, добавлять, удалять)
      tables: [
        tbl('Стол 1', '1️⃣', 'c2'),
        tbl('Стол 2', '2️⃣', 'c2'),
        tbl('Стол 3', '3️⃣', 'c3'),
        tbl('Стол 4', '4️⃣', 'c3'),
        tbl('Стол 5', '5️⃣', 'c1'),
        tbl('Стол 6', '6️⃣', 'c1'),
        tbl('Бар 1', '🍶', 'c5'),
        tbl('Бар 2', '🍶', 'c5'),
        tbl('VIP', '⭐', 'c4'),
      ],
      history: [],
    };
  },

  getTable(id) { return this.state.tables.find((t) => t.id === id); },
  get currency() { return this.state.settings.currency || '₽'; },
};

// Форматирование цены: «520 ₽»
function formatPrice(value) {
  return `${Math.round(value).toLocaleString('ru-RU')} ${DB.currency}`;
}

// Длительность в человекочитаемом виде: «5 мин», «1 ч 05 мин»
function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} ч ${String(m).padStart(2, '0')} мин`;
}

// Подписи способов оплаты
const PAYMENT = { cash: '💵 Наличные', card: '💳 Карта' };

/* ----------------------------- НАВИГАЦИЯ ----------------------------- */
const SCREENS = {
  'tables':         { title: 'Мой заказ', top: true },
  'menu':           { title: 'Меню',      top: false },
  'order':          { title: 'Заказ',     top: false },
  'history':        { title: 'История',   top: true },
  'history-detail': { title: 'Заказ',     top: false },
  'stats':          { title: 'Статистика', top: true },
};

let activeTableId = null;   // стол, с которым сейчас работаем
let reorderMode = false;    // включён ли режим перестановки столов
let menuQuery = '';         // текущий поисковый запрос в меню

const nav = {
  stack: [{ screen: 'tables', params: {} }],
  current() { return this.stack[this.stack.length - 1]; },
  go(screen, params = {}) { this.stack.push({ screen, params }); this.apply(); },
  switchTop(screen) { this.stack = [{ screen, params: {} }]; this.apply(); },
  back() { if (this.stack.length > 1) { this.stack.pop(); this.apply(); } },

  apply() {
    const { screen, params } = this.current();
    $$('.screen').forEach((s) => s.classList.toggle('is-active', s.dataset.screen === screen));
    window.scrollTo(0, 0);

    const cfg = SCREENS[screen];
    $('#topbarTitle').textContent = params.title || cfg.title;
    $$('.tabbar__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === screen));

    if (this.stack.length > 1) tg.showBackButton(); else tg.hideBackButton();
    tg.setHeaderColor(cfg.top ? 'secondary_bg_color' : 'bg_color');

    // FAB «+»
    const addFab = $('#addFab');
    if (screen === 'tables' && !reorderMode) { addFab.hidden = false; addFab.dataset.role = 'table'; }
    else if (screen === 'menu') { addFab.hidden = false; addFab.dataset.role = 'dish'; }
    else { addFab.hidden = true; }

    updateMainButton();
    renderCurrent();
  },
};

function renderCurrent() {
  const { screen, params } = nav.current();
  if (screen === 'tables') renderTables();
  else if (screen === 'menu') renderMenu();
  else if (screen === 'order') renderOrder();
  else if (screen === 'history') renderHistory();
  else if (screen === 'history-detail') renderHistoryDetail(params.orderId);
  else if (screen === 'stats') renderStats();
}

// Текущий заказ активного стола (массив строк)
function activeOrder() {
  const t = DB.getTable(activeTableId);
  return t ? t.order : [];
}

/* --------------------------- ЭКРАН СТОЛОВ --------------------------- */
function tablesView() { return DB.state.settings.tablesView || 'grid'; }

function renderTables() {
  const grid = $('#tilesGrid');
  const view = tablesView();
  // Переключатель вида
  $$('#viewSeg .seg__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));

  if (view === 'plan') {
    reorderMode = false;
    $('#reorderBtn').hidden = true;
    $('#tablesLead').textContent = 'Двигайте столы по плану, тап — открыть, долгое нажатие — изменить';
    renderFloor(grid);
    return;
  }

  $('#reorderBtn').hidden = false;
  $('#reorderBtn').classList.toggle('is-active', reorderMode);
  $('#tablesLead').textContent = reorderMode
    ? 'Двигайте столы стрелками, затем нажмите «Готово»'
    : 'Выберите стол, чтобы открыть его заказ';
  $('#reorderBtn').textContent = reorderMode ? '✓ Готово' : '↕ Порядок';

  if (reorderMode) { renderReorder(grid); return; }

  grid.className = 'tiles';
  const sumOf = (t) => t.order.reduce((s, it) => s + it.price * it.qty, 0);
  const cntOf = (t) => t.order.reduce((n, it) => n + it.qty, 0);

  grid.innerHTML = DB.state.tables.map((t) => {
    const sum = sumOf(t), cnt = cntOf(t);
    const busy = cnt > 0;
    const hasNew = t.order.some((it) => (it.status || 'new') === 'new');
    return `
      <button class="tile ${busy ? 'is-busy' : 'is-empty'} ${t.billRequested ? 'is-bill' : ''}" style="--tile:var(--${t.color})" data-table="${t.id}">
        ${busy ? `<span class="tile__count ${hasNew ? 'is-new' : ''}">${cnt}</span>` : ''}
        ${t.billRequested ? '<span class="tile__bill">💳</span>' : ''}
        <span class="tile__emoji">${esc(t.emoji)}</span>
        <span class="tile__name">${esc(t.name)}</span>
        ${busy ? `<span class="tile__sum">${formatPrice(sum)}</span>` : ''}
      </button>`;
  }).join('') + `
    <button class="tile tile--add" id="addTableTile">
      <span class="tile__emoji">＋</span>
      <span class="tile__name">Стол</span>
    </button>`;

  $$('.tile[data-table]', grid).forEach((tile) => {
    const id = tile.dataset.table;
    tile.addEventListener('click', () => openTable(id));
    attachLongPress(tile, () => openTableModal(id));
  });

  $('#addTableTile').addEventListener('click', () => openTableModal(null));
}

// Открыть стол: заказ (если есть) или меню
function openTable(id) {
  tg.haptic('light');
  activeTableId = id;
  const t = DB.getTable(id);
  if (t.order.length) nav.go('order', { title: `${t.emoji} ${t.name}` });
  else nav.go('menu', { title: `${t.emoji} ${t.name}` });
}

// ПЛАН ЗАЛА: столы как перетаскиваемые узлы на «карте»
function renderFloor(container) {
  container.className = 'floor';
  // Авторасстановка координат для столов без позиции
  let changed = false;
  DB.state.tables.forEach((t, i) => {
    if (t.x == null || t.y == null) {
      const cols = 3, c = i % cols, r = Math.floor(i / cols);
      t.x = 6 + c * 31; t.y = 4 + r * 20; changed = true;
    }
  });
  if (changed) DB.save();

  container.innerHTML = DB.state.tables.map((t) => {
    const cnt = t.order.reduce((n, it) => n + it.qty, 0);
    const busy = cnt > 0;
    const sum = t.order.reduce((s, it) => s + it.price * it.qty, 0);
    return `
      <button class="floor-table ${busy ? 'is-busy' : ''} ${t.billRequested ? 'is-bill' : ''}"
              style="--tile:var(--${t.color}); left:${t.x}%; top:${t.y}%;" data-table="${t.id}">
        ${t.billRequested ? '<span class="floor-table__bill">💳</span>' : ''}
        <span class="floor-table__emoji">${esc(t.emoji)}</span>
        <span class="floor-table__name">${esc(t.name)}</span>
        ${busy ? `<span class="floor-table__sum">${formatPrice(sum)}</span>` : ''}
      </button>`;
  }).join('');

  bindFloorDrag(container);
}

function bindFloorDrag(container) {
  $$('.floor-table', container).forEach((node) => {
    const id = node.dataset.table;
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false, lpTimer = null, longPressed = false, rect = null;

    node.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; longPressed = false;
      rect = container.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      const t = DB.getTable(id); ox = t.x; oy = t.y;
      try { node.setPointerCapture(e.pointerId); } catch (err) {}
      lpTimer = setTimeout(() => { if (!moved) { longPressed = true; tg.haptic('medium'); openTableModal(id); } }, 500);
    });
    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { moved = true; clearTimeout(lpTimer); }
      let nx = ox + dx / rect.width * 100;
      let ny = oy + dy / rect.height * 100;
      nx = Math.max(0, Math.min(80, nx));
      ny = Math.max(0, Math.min(86, ny));
      node.style.left = nx + '%'; node.style.top = ny + '%';
      node.dataset.nx = nx; node.dataset.ny = ny;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      clearTimeout(lpTimer);
      if (longPressed) return;            // было долгое нажатие → редактирование, не открываем
      if (moved) {                        // перетаскивание → сохраняем позицию
        const t = DB.getTable(id);
        if (t && node.dataset.nx != null) { t.x = parseFloat(node.dataset.nx); t.y = parseFloat(node.dataset.ny); DB.save(); }
      } else {                            // тап → открыть стол
        openTable(id);
      }
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  });
}

// Режим перестановки столов
function renderReorder(grid) {
  grid.className = '';
  grid.innerHTML = DB.state.tables.map((t, i) => `
    <div class="reorder-row" style="--accent:var(--${t.color})">
      <span class="reorder-row__emoji">${esc(t.emoji)}</span>
      <span class="reorder-row__name">${esc(t.name)}</span>
      <span class="reorder-row__btns">
        <button data-up="${t.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-down="${t.id}" ${i === DB.state.tables.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
    </div>`).join('');

  const move = (id, dir) => {
    const arr = DB.state.tables;
    const i = arr.findIndex((t) => t.id === id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    DB.save();
    tg.haptic('light');
    renderReorder(grid);
  };
  $$('[data-up]', grid).forEach((b) => b.addEventListener('click', () => move(b.dataset.up, -1)));
  $$('[data-down]', grid).forEach((b) => b.addEventListener('click', () => move(b.dataset.down, +1)));
}

/* ----------------------------- ЭКРАН МЕНЮ ----------------------------- */
// Вход в меню: сбрасываем поиск и рисуем полный список
function renderMenu() {
  menuQuery = '';
  const si = $('#menuSearch');
  if (si) si.value = '';
  $('#menuSearchClear').hidden = true;
  renderMenuList();
}

// Отрисовка списка блюд с учётом поискового запроса (menuQuery).
// Перерисовывает только #menuSections, поэтому фокус в строке поиска не теряется.
function renderMenuList() {
  const box = $('#menuSections');
  const q = menuQuery.trim().toLowerCase();

  // Фильтрация: блюдо подходит, если совпадает его название
  // ИЛИ если запрос совпал с названием раздела (тогда показываем весь раздел).
  const groups = DB.state.menu.sections.map((s) => {
    if (!q) return { s, items: s.items };
    const sectionMatch = s.name.toLowerCase().includes(q);
    const items = sectionMatch ? s.items : s.items.filter((it) => it.name.toLowerCase().includes(q));
    return { s, items };
  }).filter((g) => g.items.length);

  if (!DB.state.menu.sections.length) {
    box.innerHTML = `<p class="screen__lead">Меню пусто. Добавьте первое блюдо кнопкой ＋.</p>`;
    updateCartFab();
    return;
  }
  if (!groups.length) {
    box.innerHTML = `<p class="screen__lead">Ничего не найдено по запросу «${esc(menuQuery.trim())}». Можно добавить новое блюдо кнопкой ＋.</p>`;
    updateCartFab();
    return;
  }

  box.innerHTML = groups.map(({ s, items }) => `
    <div class="menu__section">
      <div class="menu__section-head">
        <span class="menu__section-title">${esc(s.name)}</span>
        <span class="menu__section-line"></span>
      </div>
      ${items.map((it) => `
        <button class="dish ${it.stop ? 'is-stopped' : ''}" data-dish="${it.id}" data-section="${s.id}">
          <span class="dish__emoji">${esc(it.emoji)}</span>
          <span class="dish__body">
            <span class="dish__name">${esc(it.name)}</span>
            <span class="dish__cost">${formatPrice(it.price)}${it.weight ? ' · ' + esc(it.weight) : ''}</span>
          </span>
          ${it.stop ? '<span class="dish__stop">Стоп</span>' : '<span class="dish__plus">＋</span>'}
        </button>`).join('')}
    </div>`).join('');

  $$('.dish[data-dish]', box).forEach((el) => {
    const sec = DB.state.menu.sections.find((s) => s.id === el.dataset.section);
    const item = sec.items.find((i) => i.id === el.dataset.dish);
    el.addEventListener('click', () => {
      if (item.stop) { toast('В стоп-листе — нет в наличии'); tg.haptic('warning'); return; }
      openModifiers(item);
    });
    // Долгое нажатие — редактирование / стоп-лист / удаление блюда
    attachLongPress(el, () => openDishModal(sec.id, item.id));
  });

  updateCartFab();
}

/* ------------------------- МОДИФИКАТОРЫ БЛЮДА ------------------------- */
let modState = null;

function openModifiers(item) {
  if (!activeTableId) { toast('Сначала выберите стол'); return; }
  modState = { mode: 'add', emoji: item.emoji, name: item.name, qty: 1, price: item.price, weight: item.weight || '', mods: [], note: '', course: 1 };
  fillModifiers();
  openModal('#modalModifiers');
}
function openModifiersEdit(lineId) {
  const line = activeOrder().find((i) => i.id === lineId);
  if (!line) return;
  modState = { mode: 'edit', lineId, emoji: line.emoji, name: line.name, qty: line.qty,
               price: line.price, weight: line.weight || '', mods: [...(line.mods || [])], note: line.note || '', course: line.course || 1 };
  fillModifiers();
  openModal('#modalModifiers');
}
function fillModifiers() {
  $('#modEmoji').textContent = modState.emoji;
  $('#modTitle').textContent = modState.name;
  $('#qtyVal').textContent = modState.qty;
  $('#costInput').value = modState.price;
  $('#noteInput').value = modState.note;
  $('#addToCartBtn').textContent = modState.mode === 'edit' ? 'Сохранить' : 'Добавить в заказ';
  // Чипы-модификаторы
  $('#modChips').innerHTML = MODIFIERS.map((m) =>
    `<button class="chip ${modState.mods.includes(m) ? 'is-active' : ''}" data-mod="${esc(m)}">${esc(m)}</button>`).join('');
  $$('#modChips .chip').forEach((c) => c.addEventListener('click', () => {
    const m = c.dataset.mod;
    if (modState.mods.includes(m)) modState.mods = modState.mods.filter((x) => x !== m);
    else modState.mods.push(m);
    c.classList.toggle('is-active');
  }));
  // Очередность подачи
  $$('#courseSegments .segment').forEach((s) => s.classList.toggle('is-active', +s.dataset.course === (modState.course || 1)));
}
function bindModifiers() {
  $('#qtyMinus').addEventListener('click', () => { modState.qty = Math.max(1, modState.qty - 1); $('#qtyVal').textContent = modState.qty; });
  $('#qtyPlus').addEventListener('click', () => { modState.qty += 1; $('#qtyVal').textContent = modState.qty; });
  $$('#courseSegments .segment').forEach((s) => s.addEventListener('click', () => {
    modState.course = +s.dataset.course;
    $$('#courseSegments .segment').forEach((x) => x.classList.remove('is-active'));
    s.classList.add('is-active');
  }));
  $('#addToCartBtn').addEventListener('click', commitModifiers);
}
function commitModifiers() {
  modState.price = Math.max(0, parseInt($('#costInput').value, 10) || 0);
  modState.note = $('#noteInput').value.trim();
  const t = DB.getTable(activeTableId);
  if (!t) { closeModal('#modalModifiers'); return; }

  if (modState.mode === 'add') {
    if (!t.order.length) {          // стол открывается этим первым блюдом
      t.openedAt = Date.now();
      if (!t.guests) t.guests = 1;
    }
    t.order.push({ id: uid(), emoji: modState.emoji, name: modState.name, qty: modState.qty,
                   price: modState.price, weight: modState.weight, mods: modState.mods, note: modState.note,
                   status: 'new', course: modState.course || 1 });
    DB.save();
    closeModal('#modalModifiers');
    tg.haptic('success');
    toast('Добавлено в заказ');
    updateCartFab(); updateMainButton();
  } else {
    const line = t.order.find((i) => i.id === modState.lineId);
    if (line) Object.assign(line, { qty: modState.qty, price: modState.price, mods: modState.mods, note: modState.note, course: modState.course || 1 });
    DB.save();
    closeModal('#modalModifiers');
    tg.haptic('light');
    renderOrder(); updateMainButton();
  }
}

/* ------------------------- ЭКРАН ЗАКАЗА СТОЛА ------------------------- */
function renderOrder() {
  const order = activeOrder();
  const t = DB.getTable(activeTableId);
  const list = $('#ticketList');
  const empty = $('#cartEmpty');
  const summary = $('#cartSummary');
  const addMore = $('#addMoreBtn');
  const completeBtn = $('#cartCompleteBtn');
  const sendBtn = $('#sendKitchenBtn');

  if (!order.length) {
    list.innerHTML = '';
    empty.hidden = false; summary.hidden = true; addMore.hidden = true;
    completeBtn.hidden = true; sendBtn.hidden = true;
    $('#orderMeta').hidden = true;
    $('#orderActions').hidden = true;
    return;
  }
  empty.hidden = true; summary.hidden = false; addMore.hidden = false;

  // Ленивая инициализация для заказов, созданных до этого обновления
  if (!t.openedAt) { t.openedAt = Date.now(); DB.save(); }
  if (!t.guests) { t.guests = 1; DB.save(); }

  // Панель: гости (степпер) + таймер стола
  const meta = $('#orderMeta');
  meta.hidden = false;
  meta.innerHTML = `
    <div class="order-meta__item">
      <span class="order-meta__label">👥 Гости</span>
      <div class="line-stepper">
        <button class="line-stepper__btn" id="guestMinus">−</button>
        <span class="line-stepper__val" id="guestVal">${t.guests}</span>
        <button class="line-stepper__btn" id="guestPlus">＋</button>
      </div>
    </div>
    <div class="order-meta__item order-meta__item--timer">
      <span class="order-meta__label">⏱ За столом</span>
      <span class="order-meta__timer" id="orderTimer">${formatDuration(Date.now() - t.openedAt)}</span>
    </div>`;
  const setGuests = (d) => {
    const tb = DB.getTable(activeTableId);
    if (!tb) return;
    tb.guests = Math.max(1, (tb.guests || 1) + d);
    DB.save(); tg.haptic('light');
    $('#guestVal').textContent = tb.guests;
  };
  $('#guestMinus').addEventListener('click', () => setGuests(-1));
  $('#guestPlus').addEventListener('click', () => setGuests(+1));

  // Список позиций. Если есть несколько подач — группируем с заголовками.
  const courses = [...new Set(order.map((it) => it.course || 1))].sort((a, b) => a - b);
  if (courses.length > 1) {
    list.innerHTML = courses.map((c) =>
      `<div class="course-head">🍽 Подача ${c}</div>` +
      order.filter((it) => (it.course || 1) === c).map((it) => ticketRowHTML(it, true)).join('')
    ).join('');
  } else {
    list.innerHTML = order.map((it) => ticketRowHTML(it, true)).join('');
  }
  bindTicketRows(list, true);

  const total = order.reduce((s, it) => s + it.price * it.qty, 0);
  $('#cartTotal').textContent = formatPrice(total);

  // Действия со столом: перенос и «гость просит счёт»
  const actions = $('#orderActions');
  actions.hidden = false;
  const billBtn = $('#billBtn');
  billBtn.textContent = t.billRequested ? '✓ Счёт запрошен' : '💳 Просит счёт';
  billBtn.classList.toggle('is-active', !!t.billRequested);

  // Нижние кнопки. В Telegram действия дублируются нативной MainButton (см. updateMainButton).
  const newCount = order.reduce((n, it) => n + ((it.status || 'new') === 'new' ? it.qty : 0), 0);
  if (tg.api) { sendBtn.hidden = true; completeBtn.hidden = true; }
  else if (newCount > 0) { sendBtn.hidden = false; sendBtn.textContent = `🍳 Отправить на кухню · ${newCount}`; completeBtn.hidden = true; }
  else { sendBtn.hidden = true; completeBtn.hidden = false; }
}

function ticketRowHTML(it, editable = true) {
  const st = STATUS[it.status] || STATUS.new;
  const mods = (it.mods && it.mods.length) ? it.mods.map((m) => `<span class="tag">• ${esc(m)}</span>`).join('') : '';
  const note = it.note ? `<div class="ticket-row__note">«${esc(it.note)}»</div>` : '';
  // Статус-пилюля: в активном заказе по ней можно тапать (меняет статус), в истории — статична
  const statusPill = `<button class="status-pill ${st.cls}" data-status-btn ${editable ? '' : 'disabled'}>${st.label}</button>`;
  // Справа: степпер количества (в заказе) или просто ×N (в истории)
  const right = editable
    ? `<div class="line-stepper">
         <button class="line-stepper__btn" data-minus>−</button>
         <span class="line-stepper__val">${it.qty}</span>
         <button class="line-stepper__btn" data-plus>＋</button>
       </div>`
    : (it.qty > 1 ? `<span class="ticket-row__qty">×${it.qty}</span>` : '');
  return `
    <div class="ticket-row" data-line="${it.id}">
      ${editable ? '<button class="ticket-row__delete">Удалить</button>' : ''}
      <div class="ticket-row__content">
        <span class="ticket-row__emoji">${esc(it.emoji)}</span>
        <div class="ticket-row__body">
          <div class="ticket-row__name">${esc(it.name)}</div>
          <div class="ticket-row__meta">
            ${statusPill}<span class="tag">${formatPrice(it.price)}</span>${it.weight ? `<span class="tag">${esc(it.weight)}</span>` : ''}${mods}
          </div>
          ${note}
        </div>
        ${right}
      </div>
    </div>`;
}

function bindTicketRows(root, editable) {
  $$('.ticket-row', root).forEach((row) => {
    const content = $('.ticket-row__content', row);
    const delBtn = $('.ticket-row__delete', row);
    let startX = 0, dx = 0, dragging = false, moved = false;
    const onDown = (x) => { startX = x; dx = 0; dragging = true; moved = false; };
    const onMove = (x) => {
      if (!dragging) return;
      dx = x - startX;
      if (Math.abs(dx) > 6) moved = true;
      let t = Math.min(0, Math.max(-84, dx + (row.classList.contains('is-open') ? -84 : 0)));
      content.style.transition = 'none';
      content.style.transform = `translateX(${t}px)`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      content.style.transition = ''; content.style.transform = '';
      const open = row.classList.contains('is-open');
      if (!open && dx < -42) { closeAllRows(); row.classList.add('is-open'); }
      else if (open && dx > 42) { row.classList.remove('is-open'); }
      else if (!moved) {
        if (open) row.classList.remove('is-open');
        else if (editable) openModifiersEdit(row.dataset.line);
      }
    };
    content.addEventListener('pointerdown', (e) => onDown(e.clientX));
    content.addEventListener('pointermove', (e) => onMove(e.clientX));
    content.addEventListener('pointerup', onUp);
    content.addEventListener('pointercancel', onUp);
    content.addEventListener('pointerleave', () => { if (dragging) onUp(); });
    if (delBtn) delBtn.addEventListener('click', () => removeOrderLine(row.dataset.line));

    // Степпер количества и статус-пилюля.
    // gobbleDown гасит pointerdown, чтобы строка не начала свайп/тап при нажатии этих кнопок.
    const minusBtn  = row.querySelector('[data-minus]');
    const plusBtn   = row.querySelector('[data-plus]');
    const statusBtn = row.querySelector('[data-status-btn]');
    const gobbleDown = (e) => e.stopPropagation();
    [minusBtn, plusBtn, statusBtn].forEach((b) => { if (b) b.addEventListener('pointerdown', gobbleDown); });
    if (minusBtn) minusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeQty(row.dataset.line, -1); });
    if (plusBtn)  plusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeQty(row.dataset.line, +1); });
    if (statusBtn && !statusBtn.disabled) statusBtn.addEventListener('click', (e) => { e.stopPropagation(); cycleStatus(row.dataset.line); });
  });
}
function closeAllRows() { $$('.ticket-row.is-open').forEach((r) => r.classList.remove('is-open')); }

function removeOrderLine(lineId) {
  const t = DB.getTable(activeTableId);
  if (!t) return;
  t.order = t.order.filter((i) => i.id !== lineId);
  DB.save();
  tg.haptic('warning');
  renderOrder(); updateMainButton();
}

// Изменить количество прямо в строке (минимум 1; для удаления — свайп)
function changeQty(lineId, delta) {
  const t = DB.getTable(activeTableId);
  if (!t) return;
  const line = t.order.find((i) => i.id === lineId);
  if (!line) return;
  line.qty = Math.max(1, line.qty + delta);
  DB.save();
  tg.haptic('light');
  renderOrder(); updateMainButton();
}

// Переключить статус позиции: новое → на кухне → подано → новое
function cycleStatus(lineId) {
  const t = DB.getTable(activeTableId);
  if (!t) return;
  const line = t.order.find((i) => i.id === lineId);
  if (!line) return;
  const i = STATUS_SEQ.indexOf(line.status || 'new');
  line.status = STATUS_SEQ[(i + 1) % STATUS_SEQ.length];
  DB.save();
  tg.haptic('light');
  renderOrder(); updateMainButton();
}

// Отправить на кухню: все новые позиции становятся «на кухне»
function sendToKitchen() {
  const t = DB.getTable(activeTableId);
  if (!t) return;
  let n = 0;
  t.order.forEach((it) => { if ((it.status || 'new') === 'new') { it.status = 'sent'; n += 1; } });
  if (!n) return;
  DB.save();
  tg.haptic('success');
  toast('Отправлено на кухню');
  renderOrder(); updateMainButton();
}

// Отметка «гость просит счёт» — переключатель на столе
function toggleBill() {
  const t = DB.getTable(activeTableId);
  if (!t || !t.order.length) return;
  t.billRequested = !t.billRequested;
  DB.save();
  tg.haptic('warning');
  renderOrder();
}

// Перенос заказа: открыть список столов-приёмников
function openTransfer() {
  const t = DB.getTable(activeTableId);
  if (!t || !t.order.length) return;
  const box = $('#transferList');
  const others = DB.state.tables.filter((x) => x.id !== activeTableId);
  if (!others.length) { toast('Нет других столов'); return; }
  box.innerHTML = others.map((x) => {
    const busy = x.order.length;
    return `<button class="transfer-row" data-target="${x.id}">
        <span class="transfer-row__emoji" style="background:var(--${x.color})">${esc(x.emoji)}</span>
        <span class="transfer-row__name">${esc(x.name)}</span>
        <span class="transfer-row__state">${busy ? 'занят · объединить' : 'свободен'}</span>
      </button>`;
  }).join('');
  $$('.transfer-row', box).forEach((b) => b.addEventListener('click', () => transferTo(b.dataset.target)));
  openModal('#modalTransfer');
}

function transferTo(targetId) {
  const src = DB.getTable(activeTableId);
  const dst = DB.getTable(targetId);
  if (!src || !dst) return;
  const doMove = () => {
    dst.order = dst.order.concat(src.order);
    dst.guests = (dst.guests || 0) + (src.guests || 0) || 1;
    dst.openedAt = dst.openedAt ? Math.min(dst.openedAt, src.openedAt || dst.openedAt) : (src.openedAt || Date.now());
    dst.billRequested = dst.billRequested || src.billRequested;
    src.order = []; src.guests = 0; src.openedAt = null; src.billRequested = false;
    activeTableId = dst.id;
    DB.save();
    tg.haptic('success');
    closeModal('#modalTransfer');
    toast(`Перенесено на «${dst.name}»`);
    nav.switchTop('tables');
    nav.go('order', { title: `${dst.emoji} ${dst.name}` });
  };
  if (dst.order.length) {
    tg.confirm(`За столом «${dst.name}» уже есть заказ. Объединить заказы?`, (ok) => { if (ok) doMove(); });
  } else doMove();
}

// Нажатие «Закрыть стол» → окно выбора способа оплаты
function completeOrder() {  const t = DB.getTable(activeTableId);
  if (!t || !t.order.length) return;
  $('#payTotal').textContent = formatPrice(t.order.reduce((s, it) => s + it.price * it.qty, 0));
  openModal('#modalPay');
}

// Реальное закрытие стола с выбранным способом оплаты
function closeOrderWith(method) {
  const t = DB.getTable(activeTableId);
  if (!t || !t.order.length) return;
  const total = t.order.reduce((s, it) => s + it.price * it.qty, 0);
  DB.state.history.unshift({
    id: uid(),
    date: new Date().toISOString(),
    tableId: t.id, tableName: t.name, tableEmoji: t.emoji, tableColor: t.color,
    items: t.order.map((it) => ({ ...it })),
    total,
    count: t.order.reduce((n, it) => n + it.qty, 0),
    guests: t.guests || 1,
    durationMs: t.openedAt ? (Date.now() - t.openedAt) : null,
    payment: method,
  });
  t.order = [];
  t.guests = 0;
  t.openedAt = null;
  t.billRequested = false;
  DB.save();
  tg.haptic('success');
  closeModal('#modalPay');
  toast(method === 'cash' ? 'Оплата наличными · стол закрыт' : 'Оплата картой · стол закрыт');
  nav.switchTop('tables');
}

/* ----------------------------- ИСТОРИЯ ----------------------------- */
function renderHistory() {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  if (!DB.state.history.length) { list.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  list.innerHTML = DB.state.history.map((o) => {
    const d = new Date(o.date);
    const dateStr = d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return `
      <button class="history-card" style="--accent:var(--${o.tableColor || 'c2'})" data-order="${o.id}">
        <span class="history-card__emoji">${esc(o.tableEmoji)}</span>
        <span class="history-card__body">
          <span class="history-card__title">${esc(o.tableName)} · ${o.count} поз.</span>
          <span class="history-card__date">${dateStr}</span>
        </span>
        <span class="history-card__total">${formatPrice(o.total)}</span>
      </button>`;
  }).join('');
  $$('.history-card', list).forEach((el) => el.addEventListener('click', () => {
    const o = DB.state.history.find((x) => x.id === el.dataset.order);
    nav.go('history-detail', { orderId: o.id, title: `${o.tableEmoji} ${o.tableName}` });
  }));
}

function renderHistoryDetail(orderId) {
  const o = DB.state.history.find((x) => x.id === orderId);
  if (!o) { nav.back(); return; }
  $('#historyDetailList').innerHTML = o.items.map((it) => ticketRowHTML(it, false)).join('');
  $('#historyDetailTotal').textContent = formatPrice(o.total);
  $('#repeatOrderBtn').onclick = () => repeatOrder(o);
}

// Повторить заказ — на текущий активный стол (если есть) или предложить выбрать
function repeatOrder(order) {
  // По умолчанию повторяем на тот же стол, если он ещё существует
  let target = DB.getTable(order.tableId) || DB.getTable(activeTableId) || DB.state.tables[0];
  if (!target) { toast('Нет столов для повтора'); return; }
  const apply = () => {
    target.order = order.items.map((it) => ({
      id: uid(), emoji: it.emoji, name: it.name, qty: it.qty,
      price: it.price, weight: it.weight || '', mods: [...(it.mods || [])], note: it.note || '', status: 'new',
    }));
    target.openedAt = Date.now();
    target.guests = order.guests || 1;
    activeTableId = target.id;
    DB.save();
    tg.haptic('success');
    toast(`Заказ повторён на «${target.name}»`);
    nav.switchTop('tables');
    nav.go('order', { title: `${target.emoji} ${target.name}` });
  };
  if (target.order.length) {
    tg.confirm(`За столом «${target.name}» уже есть заказ. Заменить его повтором?`, (ok) => { if (ok) apply(); });
  } else apply();
}

// Живой таймер стола на экране заказа (обновляется по интервалу)
function updateOrderTimer() {
  if (nav.current().screen !== 'order') return;
  const t = DB.getTable(activeTableId);
  const el = $('#orderTimer');
  if (el && t && t.openedAt) el.textContent = formatDuration(Date.now() - t.openedAt);
}

/* ----------------------------- СТАТИСТИКА ----------------------------- */
function renderStats() {
  const h = DB.state.history;
  const box = $('#statsContent');
  const emptyEl = $('#statsEmpty');
  if (!h.length) { box.innerHTML = ''; emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  const now = new Date();
  const isToday = (d) => {
    const x = new Date(d);
    return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth() && x.getDate() === now.getDate();
  };
  const calc = (arr) => {
    const rev = arr.reduce((s, o) => s + o.total, 0);
    const checks = arr.length;
    const guests = arr.reduce((s, o) => s + (o.guests || 0), 0);
    return { rev, checks, avg: checks ? rev / checks : 0, guests };
  };
  const all = calc(h);
  const today = calc(h.filter((o) => isToday(o.date)));

  // Топ блюд по количеству (за всё время)
  const map = {};
  h.forEach((o) => o.items.forEach((it) => { map[it.name] = (map[it.name] || 0) + it.qty; }));
  const top = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Выручка по способам оплаты
  const pay = { cash: 0, card: 0 };
  h.forEach((o) => { if (o.payment === 'cash') pay.cash += o.total; else if (o.payment === 'card') pay.card += o.total; });

  const block = (title, d) => `
    <div class="stats-block">
      <div class="stats-block__title">${title}</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-card__value">${formatPrice(d.rev)}</div><div class="stat-card__label">Выручка</div></div>
        <div class="stat-card"><div class="stat-card__value">${d.checks}</div><div class="stat-card__label">Закрытых столов</div></div>
        <div class="stat-card"><div class="stat-card__value">${formatPrice(d.avg)}</div><div class="stat-card__label">Средний чек</div></div>
        <div class="stat-card"><div class="stat-card__value">${d.guests}</div><div class="stat-card__label">Гостей</div></div>
      </div>
    </div>`;

  box.innerHTML =
    block('Сегодня', today) +
    block('За всё время', all) +
    `<div class="stats-block">
      <div class="stats-block__title">Оплата (за всё время)</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-card__value">${formatPrice(pay.cash)}</div><div class="stat-card__label">💵 Наличные</div></div>
        <div class="stat-card"><div class="stat-card__value">${formatPrice(pay.card)}</div><div class="stat-card__label">💳 Карта</div></div>
      </div>
    </div>` +
    `<div class="stats-block">
      <div class="stats-block__title">Топ-5 блюд</div>
      <div class="stat-list">
        ${top.map(([name, qty], i) => `
          <div class="stat-list__row">
            <span class="stat-list__rank">${i + 1}</span>
            <span class="stat-list__name">${esc(name)}</span>
            <span class="stat-list__qty">${qty} шт</span>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ------------------------- МОДАЛКА СТОЛА ------------------------- */
let tableEditId = null;
let pickedColor = 'c2';

function openTableModal(id) {
  tableEditId = id;
  const isEdit = !!id;
  const t = isEdit ? DB.getTable(id) : null;
  $('#catModalTitle').textContent = isEdit ? 'Редактировать стол' : 'Новый стол';
  $('#catEmoji').value = isEdit ? t.emoji : '🍽️';
  $('#catName').value = isEdit ? t.name : '';
  pickedColor = isEdit ? t.color : COLORS[DB.state.tables.length % COLORS.length];
  renderSwatches();
  $('#catDeleteBtn').hidden = !isEdit;
  openModal('#modalCategory');
}
function renderSwatches() {
  $('#catSwatches').innerHTML = COLORS.map((c) =>
    `<button class="swatch ${c === pickedColor ? 'is-active' : ''}" style="background:var(--${c})" data-color="${c}"></button>`).join('');
  $$('#catSwatches .swatch').forEach((s) => s.addEventListener('click', () => {
    pickedColor = s.dataset.color; renderSwatches();
  }));
}
function bindTableModal() {
  $('#catSaveBtn').addEventListener('click', () => {
    const emoji = $('#catEmoji').value.trim() || '🍽️';
    const name = $('#catName').value.trim();
    if (!name) { toast('Введите название стола'); return; }
    if (tableEditId) {
      const t = DB.getTable(tableEditId);
      Object.assign(t, { emoji, name, color: pickedColor });
    } else {
      DB.state.tables.push({ id: uid(), name, emoji, color: pickedColor, order: [] });
    }
    DB.save();
    closeModal('#modalCategory');
    tg.haptic('success');
    renderTables();
  });
  $('#catDeleteBtn').addEventListener('click', () => {
    if (!tableEditId) return;
    const t = DB.getTable(tableEditId);
    const warn = t.order.length ? 'За столом есть открытый заказ. Удалить стол вместе с заказом?' : 'Удалить этот стол?';
    tg.confirm(warn, (ok) => {
      if (!ok) return;
      DB.state.tables = DB.state.tables.filter((x) => x.id !== tableEditId);
      if (activeTableId === tableEditId) activeTableId = null;
      DB.save();
      closeModal('#modalCategory');
      tg.haptic('warning');
      renderTables();
    });
  });
}

/* ------------------------- МОДАЛКА БЛЮДА ------------------------- */
let dishEdit = null;   // { sectionId, dishId } при редактировании

function openDishModal(sectionId = null, dishId = null) {
  dishEdit = dishId ? { sectionId, dishId } : null;
  const isEdit = !!dishId;
  let dish = null;
  if (isEdit) {
    const sec = DB.state.menu.sections.find((s) => s.id === sectionId);
    dish = sec && sec.items.find((i) => i.id === dishId);
  }
  $('#dishModalTitle').textContent = isEdit ? 'Редактировать блюдо' : 'Новое блюдо';
  $('#taskEmoji').value = isEdit ? dish.emoji : '🍣';
  $('#taskName').value = isEdit ? dish.name : '';
  $('#taskCost').value = isEdit ? dish.price : 0;
  $('#taskWeight').value = isEdit ? (dish.weight || '') : '';
  $('#taskNewSection').value = '';
  $('#dishDeleteBtn').hidden = !isEdit;
  // Кнопка стоп-листа (только при редактировании)
  const stopBtn = $('#dishStopBtn');
  stopBtn.hidden = !isEdit;
  if (isEdit) stopBtn.textContent = dish.stop ? '✅ Вернуть в меню' : '⛔ В стоп-лист';

  $('#taskSection').innerHTML = DB.state.menu.sections.map((s) =>
    `<option value="${s.id}" ${(isEdit && s.id === sectionId) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
    || '<option value="">— нет разделов —</option>';

  openModal('#modalTask');
}
function bindDishModal() {
  $('#taskSaveBtn').addEventListener('click', () => {
    const emoji = $('#taskEmoji').value.trim() || '🍣';
    const name = $('#taskName').value.trim();
    const price = Math.max(0, parseInt($('#taskCost').value, 10) || 0);
    const weight = $('#taskWeight').value.trim();
    if (!name) { toast('Введите название блюда'); return; }

    if (dishEdit) {
      // Редактирование существующего блюда (с возможным переносом в другой раздел)
      const fromSec = DB.state.menu.sections.find((s) => s.id === dishEdit.sectionId);
      const dish = fromSec.items.find((i) => i.id === dishEdit.dishId);
      Object.assign(dish, { emoji, name, price, weight });
      const newSecName = $('#taskNewSection').value.trim();
      const targetSecId = $('#taskSection').value;
      if (newSecName) {
        const ns = { id: uid(), name: newSecName, items: [] };
        DB.state.menu.sections.push(ns);
        fromSec.items = fromSec.items.filter((i) => i.id !== dish.id);
        ns.items.push(dish);
      } else if (targetSecId && targetSecId !== dishEdit.sectionId) {
        const toSec = DB.state.menu.sections.find((s) => s.id === targetSecId);
        fromSec.items = fromSec.items.filter((i) => i.id !== dish.id);
        toSec.items.push(dish);
      }
    } else {
      // Новое блюдо
      const newSecName = $('#taskNewSection').value.trim();
      let section;
      if (newSecName) { section = { id: uid(), name: newSecName, items: [] }; DB.state.menu.sections.push(section); }
      else {
        section = DB.state.menu.sections.find((s) => s.id === $('#taskSection').value);
        if (!section) { section = { id: uid(), name: 'Без раздела', items: [] }; DB.state.menu.sections.push(section); }
      }
      section.items.push({ id: uid(), emoji, name, price, weight });
    }
    DB.save();
    closeModal('#modalTask');
    tg.haptic('success');
    renderMenu();
  });

  $('#dishDeleteBtn').addEventListener('click', () => {
    if (!dishEdit) return;
    tg.confirm('Удалить это блюдо из меню?', (ok) => {
      if (!ok) return;
      const sec = DB.state.menu.sections.find((s) => s.id === dishEdit.sectionId);
      sec.items = sec.items.filter((i) => i.id !== dishEdit.dishId);
      DB.save();
      closeModal('#modalTask');
      tg.haptic('warning');
      renderMenu();
    });
  });

  // Стоп-лист: пометить блюдо как «нет в наличии» / вернуть в меню
  $('#dishStopBtn').addEventListener('click', () => {
    if (!dishEdit) return;
    const sec = DB.state.menu.sections.find((s) => s.id === dishEdit.sectionId);
    const dish = sec.items.find((i) => i.id === dishEdit.dishId);
    dish.stop = !dish.stop;
    DB.save();
    tg.haptic('warning');
    closeModal('#modalTask');
    renderMenu();
    toast(dish.stop ? 'Блюдо в стоп-листе' : 'Блюдо снова в меню');
  });
}

/* ------------------------- НАСТРОЙКИ ------------------------- */
function openSettings() { openModal('#modalSettings'); }
function bindSettings() {
  $('#exportBtn').addEventListener('click', () => {
    const data = JSON.stringify(DB.state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `moy-zakaz-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Файл выгружен');
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !data.menu || !Array.isArray(data.tables)) throw new Error('bad');
        data.version = 2;
        data.settings = data.settings || { currency: '₽' };
        data.history = data.history || [];
        DB.state = data;
        DB.save();
        closeModal('#modalSettings');
        tg.haptic('success');
        toast('База импортирована');
        activeTableId = null;
        nav.switchTop('tables');
      } catch (err) { toast('Не удалось прочитать файл'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  $('#resetBtn').addEventListener('click', () => {
    tg.confirm('Сбросить меню, столы и историю к стандартным? Отменить нельзя.', (ok) => {
      if (!ok) return;
      DB.reset();
      activeTableId = null; reorderMode = false;
      closeModal('#modalSettings');
      tg.haptic('warning');
      nav.switchTop('tables');
    });
  });
}

/* ------------------------- ОБЩИЕ ЭЛЕМЕНТЫ ------------------------- */
function openModal(sel) { closeAllRows(); $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; }
function bindModalBackdrops() {
  $$('.modal').forEach((m) => $('.modal__backdrop', m).addEventListener('click', () => { m.hidden = true; }));
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function updateCartFab() {
  const fab = $('#cartFab');
  const onMenu = nav.current().screen === 'menu';
  const order = activeOrder();
  const n = order.reduce((s, it) => s + it.qty, 0);
  if (onMenu && n) {
    fab.hidden = false;
    $('#cartFabBadge').textContent = n;
    $('#cartFabSum').textContent = formatPrice(order.reduce((s, it) => s + it.price * it.qty, 0));
  } else fab.hidden = true;
}

function updateMainButton() {
  const onOrder = nav.current().screen === 'order';
  const order = activeOrder();
  if (onOrder && order.length) {
    const newCount = order.reduce((n, it) => n + ((it.status || 'new') === 'new' ? it.qty : 0), 0);
    if (newCount > 0) tg.mainButton(`Отправить на кухню · ${newCount}`, sendToKitchen);
    else tg.mainButton('Закрыть стол · оплачено', completeOrder);
  } else {
    tg.hideMainButton();
  }
  updateCartFab();
}

/* ------------------------- ДОЛГОЕ НАЖАТИЕ ------------------------- */
function attachLongPress(el, cb, ms = 500) {
  let timer = null, suppressClick = false;
  el.addEventListener('touchstart', () => {
    suppressClick = false;
    timer = setTimeout(() => { suppressClick = true; tg.haptic('medium'); cb(); }, ms);
  }, { passive: true });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel);
  el.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cb(); });
}

/* ------------------------- ИНИЦИАЛИЗАЦИЯ ------------------------- */
function init() {
  DB.load();
  tg.init();
  tg.onBack(() => nav.back());

  $$('.tabbar__btn').forEach((b) =>
    b.addEventListener('click', () => { tg.haptic('light'); reorderMode = false; nav.switchTop(b.dataset.nav); }));

  $('#addFab').addEventListener('click', () => {
    const role = $('#addFab').dataset.role;
    if (role === 'table') openTableModal(null);
    else if (role === 'dish') openDishModal(null, null);
  });

  $('#reorderBtn').addEventListener('click', () => {
    reorderMode = !reorderMode;
    nav.apply();
  });

  // Переключатель вида столов: сетка / план
  $$('#viewSeg .seg__btn').forEach((b) => b.addEventListener('click', () => {
    DB.state.settings.tablesView = b.dataset.view;
    DB.save();
    reorderMode = false;
    renderTables();
  }));

  // Действия со столом
  $('#transferBtn').addEventListener('click', openTransfer);
  $('#billBtn').addEventListener('click', toggleBill);

  // Поиск по меню: фильтруем список по мере ввода (фокус не теряется,
  // т.к. перерисовывается только список блюд, а не сама строка поиска)
  const search = $('#menuSearch');
  if (search) {
    search.addEventListener('input', () => {
      menuQuery = search.value;
      $('#menuSearchClear').hidden = !menuQuery.trim();
      renderMenuList();
    });
  }
  $('#menuSearchClear').addEventListener('click', () => {
    menuQuery = '';
    const s = $('#menuSearch');
    s.value = ''; s.focus();
    $('#menuSearchClear').hidden = true;
    renderMenuList();
  });

  // Плавающая кнопка счёта → экран заказа стола
  $('#cartFab').addEventListener('click', () => {
    const t = DB.getTable(activeTableId);
    nav.go('order', { title: t ? `${t.emoji} ${t.name}` : 'Заказ' });
  });
  // Кнопки на экране заказа
  $('#cartEmptyBack').addEventListener('click', () => {
    const t = DB.getTable(activeTableId);
    nav.go('menu', { title: t ? `${t.emoji} ${t.name}` : 'Меню' });
  });
  $('#addMoreBtn').addEventListener('click', () => {
    const t = DB.getTable(activeTableId);
    nav.go('menu', { title: t ? `${t.emoji} ${t.name}` : 'Меню' });
  });
  $('#cartCompleteBtn').addEventListener('click', completeOrder);
  $('#sendKitchenBtn').addEventListener('click', sendToKitchen);
  $('#payCash').addEventListener('click', () => closeOrderWith('cash'));
  $('#payCard').addEventListener('click', () => closeOrderWith('card'));

  $('#settingsBtn').addEventListener('click', openSettings);

  bindModifiers();
  bindTableModal();
  bindDishModal();
  bindSettings();
  bindModalBackdrops();

  nav.apply();

  // Живой таймер открытого стола — раз в 30 секунд
  setInterval(updateOrderTimer, 30000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
