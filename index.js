/* global SillyTavern */

/**
 * 数学公式键盘 · SillyTavern 界面扩展
 *
 * 流程：悬浮球 → 打开虚拟键盘面板 → 面板内自带 KaTeX 预览 →
 *      “插入聊天框”把公式以 ```latex 代码块写进 #send_textarea；
 *      聊天消息里的公式由官方 Extension-LaTeX 扩展负责渲染。
 *
 * 设计约束：
 * - 只用 SillyTavern.getContext()，不 import 酒馆内部模块；
 * - 自建 DOM 全部用 createElement，不把外部字符串塞进 innerHTML；
 * - 所有监听、定时器、DOM 节点都登记在 disposers 里，禁用时清干净。
 */

const MODULE_NAME = 'st-math-keyboard';
const EXT_BASE_URL = new URL('.', import.meta.url);

const ORB_ID = 'stmk-orb';
const PANEL_ID = 'stmk-panel';
const SETTINGS_CONTAINER_ID = 'extensions_settings2';
const RUNTIME_KEY = '__ST_MATH_KEYBOARD__';
const DRAG_THRESHOLD = 5;

/** 片段里标记“插完光标停在哪”的占位符，写入前会被删掉。 */
const CARET = '@@';

// ─────────────────────────────────────────────
// 设置
// ─────────────────────────────────────────────

const defaultSettings = {
    orbVisible: true,
    clearAfterInsert: true,
    draft: '',
    orb: { side: 'right', fy: 0.62 },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = clone(defaultSettings);
    }

    const settings = extensionSettings[MODULE_NAME];

    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = clone(defaultSettings[key]);
        }
    }

    if (!settings.orb || typeof settings.orb !== 'object') {
        settings.orb = clone(defaultSettings.orb);
    }
    if (settings.orb.side !== 'left' && settings.orb.side !== 'right') {
        settings.orb.side = defaultSettings.orb.side;
    }
    if (typeof settings.orb.fy !== 'number' || !Number.isFinite(settings.orb.fy)) {
        settings.orb.fy = defaultSettings.orb.fy;
    }
    settings.orb.fy = Math.min(0.95, Math.max(0.05, settings.orb.fy));
    if (typeof settings.draft !== 'string') {
        settings.draft = '';
    }
    if (typeof settings.clearAfterInsert !== 'boolean') {
        settings.clearAfterInsert = defaultSettings.clearAfterInsert;
    }
    if (typeof settings.orbVisible !== 'boolean') {
        settings.orbVisible = defaultSettings.orbVisible;
    }

    return settings;
}

/** 只在响应用户操作时调用，避免初始化阶段误覆盖用户设置。 */
function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function toast(message) {
    if (typeof window.toastr?.info === 'function') {
        window.toastr.info(message, '数学公式键盘');
    } else {
        console.log(`[${MODULE_NAME}] ${message}`);
    }
}

// ─────────────────────────────────────────────
// KaTeX（懒加载，只在第一次打开面板时读取）
// ─────────────────────────────────────────────

let katexApi = null;
let katexPromise = null;
let katexFailed = false;

function loadKatex() {
    if (!katexPromise) {
        // 用 .js 后缀承载 ES 模块：避免个别静态服务把 .mjs 按二进制类型返回导致模块被拒载。
        const url = new URL('vendor/katex/katex.esm.js', EXT_BASE_URL).href;
        katexPromise = import(/* webpackIgnore: true */ url)
            .then((module) => {
                katexApi = module.default ?? module;
                return katexApi;
            })
            .catch((error) => {
                katexFailed = true;
                console.warn(`[${MODULE_NAME}] 公式渲染库加载失败，预览退化为纯文本。`, error);
                return null;
            });
    }
    return katexPromise;
}

/**
 * 把一段 LaTeX 渲染进指定节点。渲染库没准备好或出错时退回纯文本。
 * @returns {boolean} 是否渲染成功
 */
function renderMathInto(node, tex, displayMode) {
    node.replaceChildren();

    if (!katexApi) {
        node.textContent = tex;
        return false;
    }

    try {
        katexApi.render(tex, node, {
            throwOnError: false,
            displayMode: Boolean(displayMode),
            strict: 'ignore',
            errorColor: '#e06c75',
        });
        return true;
    } catch (error) {
        node.textContent = tex;
        return false;
    }
}

// ─────────────────────────────────────────────
// 键盘内容
// ─────────────────────────────────────────────

/**
 * @param {string} show 按钮上展示的 LaTeX（用 KaTeX 渲染成符号）
 * @param {string} tex  实际插入的 LaTeX 片段
 * @param {string|null} label 给了 label 就显示纯文字，不再渲染（用于矩阵这类会撑爆按钮的模板）
 */
function key(show, tex, label = null) {
    const index = tex.indexOf(CARET);
    if (index < 0) {
        return { show, tex, caret: null, label };
    }
    return { show, tex: tex.replace(CARET, ''), caret: index, label };
}

/** 铺满一个按钮的简易符号：显示什么就插入什么。 */
function sym(tex) {
    return key(tex, tex);
}

const CATEGORIES = [
    {
        id: 'tpl',
        name: '常用模板',
        items: [
            key('\\frac{a}{b}', `\\frac{${CARET}}{}`),
            key('\\sqrt{x}', `\\sqrt{${CARET}}`),
            key('\\sqrt[n]{x}', `\\sqrt[n]{${CARET}}`),
            key('\\left(\\right)', `\\left(${CARET}\\right)`),
            key('\\binom{n}{k}', `\\binom{${CARET}}{}`),
            key('\\lim_{x\\to 0}', `\\lim_{${CARET}}`),
            key('\\sum_{i=1}^{n}', `\\sum_{${CARET}}^{n}`),
            key('\\prod_{i=1}^{n}', `\\prod_{${CARET}}^{n}`),
            key('\\int_{a}^{b}', `\\int_{${CARET}}^{b}`),
            key('\\frac{\\mathrm{d}y}{\\mathrm{d}x}', `\\frac{\\mathrm{d}${CARET}}{\\mathrm{d}x}`),
            key('\\frac{\\partial f}{\\partial x}', `\\frac{\\partial ${CARET}}{\\partial x}`),
            key('\\vec{v}', `\\vec{${CARET}}`),
            key('\\overline{x}', `\\overline{${CARET}}`),
            key('\\%', '\\%'),
            key('\\pm', '\\pm'),
            key('\\approx', '\\approx'),
        ],
    },
    {
        id: 'greek',
        name: '希腊字母',
        items: [
            sym('\\alpha'), sym('\\beta'), sym('\\gamma'), sym('\\delta'),
            sym('\\epsilon'), sym('\\varepsilon'), sym('\\zeta'), sym('\\eta'),
            sym('\\theta'), sym('\\vartheta'), sym('\\iota'), sym('\\kappa'),
            sym('\\lambda'), sym('\\mu'), sym('\\nu'), sym('\\xi'),
            sym('\\pi'), sym('\\varpi'), sym('\\rho'), sym('\\varrho'),
            sym('\\sigma'), sym('\\varsigma'), sym('\\tau'), sym('\\upsilon'),
            sym('\\phi'), sym('\\varphi'), sym('\\chi'), sym('\\psi'),
            sym('\\omega'), sym('\\Gamma'), sym('\\Delta'), sym('\\Theta'),
            sym('\\Lambda'), sym('\\Xi'), sym('\\Pi'), sym('\\Sigma'),
            sym('\\Upsilon'), sym('\\Phi'), sym('\\Psi'), sym('\\Omega'),
        ],
    },
    {
        id: 'op',
        name: '运算符',
        items: [
            sym('+'), sym('-'), sym('\\pm'), sym('\\mp'),
            sym('\\times'), sym('\\div'), sym('\\cdot'), sym('\\ast'),
            sym('\\star'), sym('\\circ'), sym('\\bullet'), sym('\\oplus'),
            sym('\\ominus'), sym('\\otimes'), sym('\\odot'), sym('\\oslash'),
            sym('\\cup'), sym('\\cap'), sym('\\sqcup'), sym('\\sqcap'),
            sym('\\setminus'), sym('\\wedge'), sym('\\vee'), sym('\\neg'),
            sym('\\oplus'), sym('\\dagger'), sym('\\ddagger'), sym('\\amalg'),
        ],
    },
    {
        id: 'rel',
        name: '关系符',
        items: [
            sym('='), sym('\\neq'), sym('\\approx'), sym('\\equiv'),
            sym('\\cong'), sym('\\sim'), sym('\\simeq'), sym('\\propto'),
            sym('<'), sym('>'), sym('\\leq'), sym('\\geq'),
            sym('\\ll'), sym('\\gg'), sym('\\prec'), sym('\\preceq'),
            sym('\\succ'), sym('\\succeq'), sym('\\in'), sym('\\notin'),
            sym('\\ni'), sym('\\subset'), sym('\\subseteq'), sym('\\supset'),
            sym('\\supseteq'), sym('\\perp'), sym('\\parallel'), sym('\\mid'),
            sym('\\nmid'), sym('\\asymp'), sym('\\doteq'), sym('\\triangleq'),
        ],
    },
    {
        id: 'arrow',
        name: '箭头',
        items: [
            sym('\\to'), sym('\\rightarrow'), sym('\\leftarrow'), sym('\\leftrightarrow'),
            sym('\\Rightarrow'), sym('\\Leftarrow'), sym('\\Leftrightarrow'), sym('\\implies'),
            sym('\\iff'), sym('\\mapsto'), sym('\\longmapsto'), sym('\\uparrow'),
            sym('\\downarrow'), sym('\\updownarrow'), sym('\\nearrow'), sym('\\searrow'),
            sym('\\hookrightarrow'), sym('\\hookleftarrow'), sym('\\rightsquigarrow'), sym('\\leadsto'),
        ],
    },
    {
        id: 'big',
        name: '大型算子',
        items: [
            sym('\\sum'), sym('\\prod'), sym('\\coprod'), sym('\\int'),
            sym('\\iint'), sym('\\iiint'), sym('\\oint'), sym('\\oiint'),
            sym('\\bigcup'), sym('\\bigcap'), sym('\\bigoplus'), sym('\\bigotimes'),
            sym('\\bigvee'), sym('\\bigwedge'), sym('\\lim'), sym('\\sup'),
            sym('\\inf'), sym('\\max'), sym('\\min'), sym('\\limsup'),
            sym('\\liminf'), sym('\\sup'), sym('\\inf'), sym('\\det'),
        ],
    },
    {
        id: 'func',
        name: '函数',
        items: [
            sym('\\sin'), sym('\\cos'), sym('\\tan'), sym('\\cot'),
            sym('\\sec'), sym('\\csc'), sym('\\arcsin'), sym('\\arccos'),
            sym('\\arctan'), sym('\\sinh'), sym('\\cosh'), sym('\\tanh'),
            sym('\\coth'), sym('\\log'), sym('\\ln'), sym('\\lg'),
            sym('\\exp'), sym('\\det'), sym('\\dim'), sym('\\ker'),
            sym('\\deg'), sym('\\gcd'), sym('\\hom'), sym('\\arg'),
        ],
    },
    {
        id: 'script',
        name: '上下标',
        items: [
            key('x^{2}', `x^{${CARET}}`),
            key('x_{n}', `x_{${CARET}}`),
            key('x_{i}^{2}', `x_{${CARET}}^{2}`),
            key('a^{b^{c}}', `a^{b^{${CARET}}}`),
            key('x_{i,j}', `x_{${CARET}}`),
            key('x^{\\prime}', `x^{\\prime${CARET}}`),
            key('a_{n+1}', `a_{n+1${CARET}}`),
            key('10^{-9}', `10^{${CARET}}`),
            key('n!', 'n!'),
            key('\\binom{n}{k}', `\\binom{${CARET}}{k}`),
            key('\\overset{a}{b}', `\\overset{${CARET}}{}`),
            key('\\underset{a}{b}', `\\underset{${CARET}}{}`),
            key('\\stackrel{a}{b}', `\\stackrel{${CARET}}{}`),
        ],
    },
    {
        id: 'matrix',
        name: '矩阵/方程组',
        items: [
            key('', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', '2×2 矩阵'),
            key('', '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', '方括号矩阵'),
            key('', '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', '行列式'),
            key('', '\\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}', '行内小矩阵'),
            key('', '\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}', '方程组'),
            key('', 'f(x) = \\begin{cases} a, & x > 0 \\\\ b, & x \\leq 0 \\end{cases}', '分段函数'),
            key('', '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}', '多行对齐'),
            key('', '\\left[ \\begin{array}{cc} a & b \\\\ c & d \\end{array} \\right]', 'array 矩阵'),
            key('', '\\begin{matrix} a & b \\\\ c & d \\end{matrix}', '无括号矩阵'),
        ],
    },
    {
        id: 'deco',
        name: '装饰',
        items: [
            key('\\hat{x}', `\\hat{${CARET}}`),
            key('\\widehat{xyz}', `\\widehat{${CARET}}`),
            key('\\bar{x}', `\\bar{${CARET}}`),
            key('\\overline{xyz}', `\\overline{${CARET}}`),
            key('\\underline{x}', `\\underline{${CARET}}`),
            key('\\vec{v}', `\\vec{${CARET}}`),
            key('\\dot{x}', `\\dot{${CARET}}`),
            key('\\ddot{x}', `\\ddot{${CARET}}`),
            key('\\tilde{x}', `\\tilde{${CARET}}`),
            key('\\widetilde{xyz}', `\\widetilde{${CARET}}`),
            key('\\overbrace{a+b}', `\\overbrace{${CARET}}`),
            key('\\underbrace{a+b}', `\\underbrace{${CARET}}`),
            key('\\overrightarrow{AB}', `\\overrightarrow{${CARET}}`),
            key('\\overleftarrow{AB}', `\\overleftarrow{${CARET}}`),
            key('\\boxed{x}', `\\boxed{${CARET}}`),
            key('\\cancel{x}', `\\cancel{${CARET}}`),
        ],
    },
    {
        id: 'delim',
        name: '定界符',
        items: [
            sym('('), sym(')'), sym('['), sym(']'),
            sym('\\{'), sym('\\}'), sym('\\langle'), sym('\\rangle'),
            sym('\\lfloor'), sym('\\rfloor'), sym('\\lceil'), sym('\\rceil'),
            key('\\left| x \\right|', `\\left|${CARET}\\right|`),
            key('\\left\\| x \\right\\|', `\\left\\|${CARET}\\right\\|`),
            key('\\left\\{ x \\right\\}', `\\left\\{${CARET}\\right\\}`),
            key('\\left[ x \\right]', `\\left[${CARET}\\right]`),
            key('\\left( x \\right)', `\\left(${CARET}\\right)`),
            key('\\left\\langle x \\right\\rangle', `\\left\\langle ${CARET}\\right\\rangle`),
        ],
    },
    {
        id: 'text',
        name: '文字/间距',
        items: [
            key('\\text{文字}', `\\text{${CARET}}`),
            key('\\mathrm{abc}', `\\mathrm{${CARET}}`),
            key('\\mathbf{abc}', `\\mathbf{${CARET}}`),
            key('\\mathbb{R}', `\\mathbb{${CARET}}`),
            key('\\mathcal{L}', `\\mathcal{${CARET}}`),
            key('\\mathfrak{g}', `\\mathfrak{${CARET}}`),
            sym('\\quad'),
            sym('\\qquad'),
            sym('\\,'),
            sym('\\;'),
            sym('\\:'),
            sym('\\!'),
            sym('\\ '),
            sym('\\\\'),
            sym('\\infty'),
            sym('\\nabla'),
            sym('\\partial'),
            sym('\\forall'),
            sym('\\exists'),
            sym('\\nexists'),
            sym('\\emptyset'),
            sym('\\varnothing'),
            sym('\\aleph'),
            sym('\\hbar'),
            sym('\\ell'),
            sym('\\Re'),
            sym('\\Im'),
            sym('\\angle'),
            sym('\\triangle'),
            sym('\\square'),
            sym('\\surd'),
            sym('\\top'),
            sym('\\bot'),
            sym('\\vdash'),
            sym('\\models'),
        ],
    },
];

// 供离线自检脚本读取；酒馆运行时只会用到下面导出的生命周期钩子。
export { CATEGORIES };

// ─────────────────────────────────────────────
// DOM 小工具
// ─────────────────────────────────────────────

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);

    for (const [name, value] of Object.entries(props)) {
        if (value === null || value === undefined) {
            continue;
        }
        if (name === 'class') {
            node.className = value;
        } else if (name === 'text') {
            node.textContent = value;
        } else if (name === 'dataset') {
            Object.assign(node.dataset, value);
        } else if (name.startsWith('on') && typeof value === 'function') {
            node.addEventListener(name.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(name, value);
        }
    }

    for (const child of [].concat(children)) {
        if (child) {
            node.append(child);
        }
    }

    return node;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// ─────────────────────────────────────────────
// 运行时状态
// ─────────────────────────────────────────────

let orb = null;
let panel = null;
let draftEl = null;
let previewEl = null;
let tabsEl = null;
let keysEl = null;

let currentCategoryId = CATEGORIES[0].id;
let previewTimer = null;
let gesture = null;
let suppressClick = false;
let destroyed = true;
let disposers = [];

function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
}

// ─────────────────────────────────────────────
// 插入聊天输入框
// ─────────────────────────────────────────────

/** 官方 LaTeX 扩展认的是带 latex 语言标记的代码块。 */
function buildLatexBlock(tex) {
    return '```latex\n' + tex + '\n```';
}

function insertIntoChatTextarea(text) {
    const textarea = document.getElementById('send_textarea');

    if (!(textarea instanceof HTMLTextAreaElement)) {
        toast('找不到聊天输入框，先在酒馆里打开聊天界面再试。');
        return false;
    }

    const value = textarea.value;
    const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : value.length;
    const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
    const before = value.slice(0, start);
    const after = value.slice(end);

    let block = text;
    if (before.length > 0 && !before.endsWith('\n')) {
        block = '\n' + block;
    }
    if (after.length > 0 && !after.startsWith('\n')) {
        block = block + '\n';
    }

    textarea.value = before + block + after;
    const caret = before.length + block.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();

    return true;
}

// ─────────────────────────────────────────────
// 预览与草稿
// ─────────────────────────────────────────────

function renderPreview() {
    if (!previewEl) {
        return;
    }

    const tex = draftEl.value.trim();
    previewEl.replaceChildren();

    if (!tex) {
        previewEl.classList.add('stmk-preview-empty');
        return;
    }

    previewEl.classList.remove('stmk-preview-empty');
    renderMathInto(previewEl, tex, true);
}

function schedulePreview() {
    if (previewTimer !== null) {
        window.clearTimeout(previewTimer);
    }
    previewTimer = window.setTimeout(() => {
        previewTimer = null;
        renderPreview();
    }, 120);
}

function persistDraft() {
    const settings = getSettings();
    if (settings.draft === draftEl.value) {
        return;
    }
    settings.draft = draftEl.value;
    saveSettings();
}

function insertSnippet(item) {
    if (!draftEl) {
        return;
    }

    const value = draftEl.value;
    const start = typeof draftEl.selectionStart === 'number' ? draftEl.selectionStart : value.length;
    const end = typeof draftEl.selectionEnd === 'number' ? draftEl.selectionEnd : start;
    const before = value.slice(0, start);
    const after = value.slice(end);

    draftEl.value = before + item.tex + after;
    const caret = before.length + (item.caret === null ? item.tex.length : item.caret);
    draftEl.focus();
    draftEl.setSelectionRange(caret, caret);

    schedulePreview();
    persistDraft();
}

async function copyDraft() {
    const tex = draftEl.value.trim();
    if (!tex) {
        toast('草稿是空的。');
        return;
    }

    try {
        await navigator.clipboard.writeText(tex);
        toast('已复制 LaTeX 原文。');
    } catch (error) {
        // 剪贴板 API 不可用时退回临时文本框
        const scratch = el('textarea', { style: 'position:fixed;opacity:0;pointer-events:none;' });
        scratch.value = tex;
        document.body.append(scratch);
        scratch.select();
        try {
            document.execCommand('copy');
            toast('已复制 LaTeX 原文。');
        } catch (fallbackError) {
            toast('复制失败，请手动选中草稿内容。');
        }
        scratch.remove();
    }
}

// ─────────────────────────────────────────────
// 面板
// ─────────────────────────────────────────────

function renderKeys(categoryId) {
    if (!keysEl) {
        return;
    }

    const category = CATEGORIES.find((item) => item.id === categoryId) ?? CATEGORIES[0];
    currentCategoryId = category.id;
    keysEl.replaceChildren();

    for (const item of category.items) {
        const button = el('button', {
            class: 'stmk-key',
            type: 'button',
            title: item.tex,
        });

        if (item.label) {
            button.classList.add('stmk-key-wide');
            button.textContent = item.label;
        } else {
            renderMathInto(button, item.show || item.tex, false);
        }

        // 这些按钮每次渲染都会整体重建，直接绑在自己的节点上即可；
        // 节点被 replaceChildren 丢弃时监听随之回收，不占用全局清理列表。
        button.addEventListener('click', () => insertSnippet(item));
        keysEl.append(button);
    }

    fitAllKeys();
}

/** 宽公式按比例缩到格子内，避免把按钮和面板撑变形。 */
function fitKeyMath(button) {
    const inner = button.querySelector('.katex');
    if (!inner) {
        return;
    }

    inner.style.transform = '';
    const available = button.clientWidth - 10;
    const width = inner.getBoundingClientRect().width;

    if (available > 8 && width > available) {
        inner.style.transformOrigin = 'center center';
        inner.style.transform = `scale(${(available / width).toFixed(3)})`;
    }
}

function fitAllKeys() {
    if (!keysEl) {
        return;
    }
    for (const button of keysEl.children) {
        fitKeyMath(button);
    }
}

function renderTabs() {
    if (!tabsEl) {
        return;
    }

    tabsEl.replaceChildren();

    for (const category of CATEGORIES) {
        const tab = el('button', {
            class: 'stmk-tab',
            type: 'button',
            text: category.name,
            dataset: { category: category.id },
        });
        if (category.id === currentCategoryId) {
            tab.classList.add('stmk-tab-active');
        }
        tab.addEventListener('click', () => {
            currentCategoryId = category.id;
            for (const sibling of tabsEl.children) {
                sibling.classList.toggle('stmk-tab-active', sibling === tab);
            }
            renderKeys(category.id);
        });
        tabsEl.append(tab);
    }
}

function positionPanel() {
    if (!panel || !orb || panel.hidden) {
        return;
    }

    const margin = 12;
    const orbRect = orb.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const settings = getSettings();

    let left = settings.orb.side === 'left'
        ? orbRect.right + margin
        : orbRect.left - width - margin;
    let top = orbRect.top + orbRect.height / 2 - height / 2;

    left = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));
    top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
}

function openPanel() {
    if (!panel) {
        return;
    }

    panel.hidden = false;
    orb?.setAttribute('aria-expanded', 'true');
    orb?.classList.add('stmk-orb-active');
    renderTabs();
    renderKeys(currentCategoryId);
    renderPreview();
    positionPanel();

    // 渲染库第一次读到需要一点时间；就绪后把按钮和预览升级成图形。
    loadKatex().then(() => {
        if (!destroyed && panel && !panel.hidden) {
            renderKeys(currentCategoryId);
            renderPreview();
        }
    });
}

function closePanel() {
    if (!panel) {
        return;
    }

    panel.hidden = true;
    orb?.setAttribute('aria-expanded', 'false');
    orb?.classList.remove('stmk-orb-active');
    persistDraft();
}

function togglePanel() {
    if (!panel) {
        return;
    }
    if (panel.hidden) {
        openPanel();
    } else {
        closePanel();
    }
}

function createPanel() {
    previewEl = el('div', { class: 'stmk-preview-math' });
    const previewBox = el('div', { class: 'stmk-preview' }, [previewEl]);

    draftEl = el('textarea', {
        class: 'text_pole stmk-draft',
        rows: '2',
        spellcheck: 'false',
        placeholder: '在这里编辑 LaTeX，或点下面的按钮拼公式…',
        'aria-label': 'LaTeX 草稿',
    });
    draftEl.value = getSettings().draft ?? '';

    listen(draftEl, 'input', () => {
        schedulePreview();
        persistDraft();
    });
    listen(draftEl, 'keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closePanel();
        }
    });

    tabsEl = el('div', { class: 'stmk-tabs' });
    keysEl = el('div', { class: 'stmk-keys' });

    const insertButton = el('button', { class: 'menu_button stmk-primary', type: 'button', text: '插入聊天框' });
    const copyButton = el('button', { class: 'menu_button', type: 'button', text: '复制' });
    const clearButton = el('button', { class: 'menu_button', type: 'button', text: '清空' });

    listen(insertButton, 'click', () => {
        const tex = draftEl.value.trim();
        if (!tex) {
            toast('草稿是空的，先拼一个公式。');
            return;
        }
        if (!insertIntoChatTextarea(buildLatexBlock(tex))) {
            return;
        }
        toast('已插入到聊天输入框。');
        if (getSettings().clearAfterInsert) {
            draftEl.value = '';
            persistDraft();
            renderPreview();
        }
    });
    listen(copyButton, 'click', () => copyDraft());
    listen(clearButton, 'click', () => {
        draftEl.value = '';
        persistDraft();
        renderPreview();
        draftEl.focus();
    });

    const header = el('header', { class: 'stmk-header' }, [
        el('span', { class: 'stmk-title', text: '数学公式键盘' }),
        el('button', {
            class: 'stmk-icon-btn',
            type: 'button',
            text: '✕',
            'aria-label': '关闭公式键盘',
            onclick: () => closePanel(),
        }),
    ]);

    panel = el('div', {
        id: PANEL_ID,
        class: 'stmk-panel',
        role: 'dialog',
        'aria-label': '数学公式键盘',
        hidden: 'hidden',
    }, [
        header,
        previewBox,
        draftEl,
        tabsEl,
        keysEl,
        el('footer', { class: 'stmk-footer' }, [insertButton, copyButton, clearButton]),
    ]);

    return panel;
}

// ─────────────────────────────────────────────
// 悬浮球
// ─────────────────────────────────────────────

function applyOrbPosition() {
    if (!orb) {
        return;
    }

    const settings = getSettings();
    const margin = 12;
    const size = orb.offsetHeight || 48;
    const top = clamp(settings.orb.fy * window.innerHeight, margin, Math.max(margin, window.innerHeight - size - margin));

    orb.style.top = `${Math.round(top)}px`;
    orb.style.left = '';
    orb.style.right = '';
    if (settings.orb.side === 'left') {
        orb.style.left = `${margin}px`;
    } else {
        orb.style.right = `${margin}px`;
    }
}

function settleOrb() {
    if (!orb) {
        return;
    }

    const settings = getSettings();
    const rect = orb.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;

    settings.orb.side = centerX < window.innerWidth / 2 ? 'left' : 'right';
    settings.orb.fy = clamp((rect.top + rect.height / 2) / window.innerHeight, 0.05, 0.95);

    applyOrbPosition();
    saveSettings();
    positionPanel();
}

function onOrbPointerDown(event) {
    if (!orb || gesture) {
        return;
    }
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
        return;
    }

    gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        rect: orb.getBoundingClientRect(),
        dragging: false,
    };

    try {
        orb.setPointerCapture(event.pointerId);
    } catch (error) {
        // 某些老浏览器不支持指针捕获，忽略即可
    }
}

function onOrbPointerMove(event) {
    if (!gesture || !orb || event.pointerId !== gesture.pointerId) {
        return;
    }

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (!gesture.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        gesture.dragging = true;
        orb.classList.add('stmk-orb-dragging');
        closePanel();
    }

    if (!gesture.dragging) {
        return;
    }

    event.preventDefault();
    const left = clamp(gesture.rect.left + dx, 8, window.innerWidth - gesture.rect.width - 8);
    const top = clamp(gesture.rect.top + dy, 8, window.innerHeight - gesture.rect.height - 8);
    orb.style.right = '';
    orb.style.left = `${Math.round(left)}px`;
    orb.style.top = `${Math.round(top)}px`;
}

function onOrbPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
    }

    const wasDragging = gesture.dragging;
    gesture = null;
    orb?.classList.remove('stmk-orb-dragging');

    try {
        orb?.releasePointerCapture(event.pointerId);
    } catch (error) {
        // 指针捕获可能已被系统释放
    }

    if (wasDragging) {
        suppressClick = true;
        settleOrb();
    }
}

function onOrbPointerCancel(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
    }

    const wasDragging = gesture.dragging;
    gesture = null;
    orb?.classList.remove('stmk-orb-dragging');

    if (wasDragging) {
        suppressClick = true;
        settleOrb();
    }
}

function createOrb() {
    const node = el('button', {
        id: ORB_ID,
        class: 'stmk-orb',
        type: 'button',
        'aria-label': '打开数学公式键盘',
        'aria-controls': PANEL_ID,
        'aria-expanded': 'false',
        title: '数学公式键盘',
    }, [
        el('span', { class: 'stmk-orb-glyph', text: '∑' }),
    ]);

    listen(node, 'pointerdown', onOrbPointerDown);
    listen(node, 'pointermove', onOrbPointerMove);
    listen(node, 'pointerup', onOrbPointerUp);
    listen(node, 'pointercancel', onOrbPointerCancel);
    listen(node, 'click', (event) => {
        if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            return;
        }
        togglePanel();
    });
    listen(node, 'keydown', (event) => {
        if (event.key === 'Escape') {
            closePanel();
        }
    });

    return node;
}

// ─────────────────────────────────────────────
// 设置面板
// ─────────────────────────────────────────────

async function loadSettingsMarkup() {
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    // 酒馆里是 "third-party/扩展名"；本地预演沙盘里则是普通的目录名，
    // 所以这里只做前缀/斜杠清理，不写死酒馆的路径结构。
    const templateId = EXT_BASE_URL.pathname
        .replace(/^\/scripts\/extensions\//, '')
        .replace(/^\/+/, '')
        .replace(/\/$/, '');

    try {
        const html = await renderExtensionTemplateAsync(templateId, 'settings');
        if (html) {
            return html;
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 设置模板渲染失败，改用直接抓取。`, error);
    }

    const response = await fetch(new URL('settings.html', EXT_BASE_URL));
    return response.ok ? response.text() : '';
}

function syncSettingsPanel() {
    const settings = getSettings();
    const orbToggle = document.getElementById('stmk_orb_visible');
    const clearToggle = document.getElementById('stmk_clear_after_insert');

    if (orbToggle instanceof HTMLInputElement) {
        orbToggle.checked = settings.orbVisible;
    }
    if (clearToggle instanceof HTMLInputElement) {
        clearToggle.checked = settings.clearAfterInsert;
    }
}

function applyOrbVisibility() {
    if (!orb) {
        return;
    }
    orb.hidden = !getSettings().orbVisible;
    if (orb.hidden) {
        closePanel();
    }
}

async function mountSettingsPanel() {
    const container = document.getElementById(SETTINGS_CONTAINER_ID);
    if (!container) {
        return false;
    }
    if (document.querySelector('.stmk-settings')) {
        return true;
    }

    const html = await loadSettingsMarkup();
    if (!html) {
        return false;
    }

    container.insertAdjacentHTML('beforeend', html);
    syncSettingsPanel();

    const orbToggle = document.getElementById('stmk_orb_visible');
    const clearToggle = document.getElementById('stmk_clear_after_insert');
    const resetButton = document.getElementById('stmk_reset_orb');

    if (orbToggle instanceof HTMLInputElement) {
        listen(orbToggle, 'change', () => {
            getSettings().orbVisible = orbToggle.checked;
            saveSettings();
            applyOrbVisibility();
        });
    }

    if (clearToggle instanceof HTMLInputElement) {
        listen(clearToggle, 'change', () => {
            getSettings().clearAfterInsert = clearToggle.checked;
            saveSettings();
        });
    }

    if (resetButton instanceof HTMLElement) {
        listen(resetButton, 'click', () => {
            const settings = getSettings();
            settings.orb.side = defaultSettings.orb.side;
            settings.orb.fy = defaultSettings.orb.fy;
            saveSettings();
            applyOrbPosition();
            toast('悬浮球位置已重置。');
        });
    }

    return true;
}

// ─────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────

function destroy() {
    if (destroyed) {
        return;
    }
    destroyed = true;

    if (previewTimer !== null) {
        window.clearTimeout(previewTimer);
        previewTimer = null;
    }
    gesture = null;
    suppressClick = false;

    while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
            dispose();
        } catch (error) {
            console.warn(`[${MODULE_NAME}] 清理监听失败`, error);
        }
    }

    try {
        orb?.remove();
    } catch (error) {
        /* 忽略 */
    }
    try {
        panel?.remove();
    } catch (error) {
        /* 忽略 */
    }
    try {
        document.querySelector('.stmk-settings')?.remove();
    } catch (error) {
        /* 忽略 */
    }

    orb = null;
    panel = null;
    draftEl = null;
    previewEl = null;
    tabsEl = null;
    keysEl = null;

    if (window[RUNTIME_KEY]?.destroy === destroy) {
        delete window[RUNTIME_KEY];
    }
}

function removeStaleNodes() {
    document.getElementById(ORB_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    document.querySelectorAll('.stmk-settings').forEach((node) => node.remove());
}

async function init() {
    const previous = window[RUNTIME_KEY];
    if (previous && typeof previous.destroy === 'function') {
        try {
            previous.destroy();
        } catch (error) {
            console.warn(`[${MODULE_NAME}] 旧实例清理失败`, error);
        }
    }

    destroyed = false;
    window[RUNTIME_KEY] = { destroy };

    removeStaleNodes();

    orb = createOrb();
    document.body.append(orb);
    applyOrbPosition();
    applyOrbVisibility();

    panel = createPanel();
    document.body.append(panel);

    listen(window, 'resize', () => {
        applyOrbPosition();
        positionPanel();
        fitAllKeys();
    });
    listen(document, 'keydown', (event) => {
        if (event.key === 'Escape' && panel && !panel.hidden) {
            closePanel();
        }
    });

    const mounted = await mountSettingsPanel();
    if (!mounted) {
        const { eventSource, event_types } = SillyTavern.getContext();
        eventSource.once(event_types.APP_READY, () => {
            if (!destroyed) {
                mountSettingsPanel();
            }
        });
    }

    loadKatex();
}

export async function onActivate() {
    try {
        await init();
    } catch (error) {
        console.error(`[${MODULE_NAME}] 初始化失败`, error);
    }
}

export function onDisable() {
    destroy();
}

export function onClean() {
    destroy();
    try {
        const { extensionSettings } = SillyTavern.getContext();
        delete extensionSettings[MODULE_NAME];
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 清理设置失败`, error);
    }
}

// 兜底：若宿主没有调用 activate 钩子，等应用就绪后自行初始化一次。
try {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.once(event_types.APP_READY, () => {
        if (!window[RUNTIME_KEY]) {
            init().catch((error) => console.error(`[${MODULE_NAME}] 兜底初始化失败`, error));
        }
    });
} catch (error) {
    console.warn(`[${MODULE_NAME}] 无法注册兜底初始化`, error);
}
