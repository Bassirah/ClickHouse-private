#!/usr/bin/env node
/// Builds the Console Guide, the documentation of the web console shown inside the console, from the pages of
/// the documentation site: `docs/products/web-console/*.mdx` and its `navigation.json`. The result,
/// `programs/server/console_guide.json`, is embedded in the server and served at `/console/guide.json`.
///
///     node utils/web-console/build_guide.mjs           # writes programs/server/console_guide.json
///     node utils/web-console/build_guide.mjs --check   # fails if the file is not up to date
///
/// The pages are converted at build time, so the console needs no Markdown library and no network. Only what the
/// pages use is supported: frontmatter, headings with `{#anchor}`, paragraphs, nested lists, fenced code, tables,
/// emphasis, inline code, links, the components `Note`, `Tip`, `Warning`, `Steps`/`Step`, and `Tabs`/`Tab`, and
/// Mermaid flowcharts, shown as a table of their connections. Anything else is an error, not silently dropped.
/// Links to other pages of the guide become console routes, and must point to an existing page and anchor; other
/// links of the documentation site keep their path, and the console resolves them against `documentation_url`.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SOURCE = path.join(ROOT, 'docs/products/web-console');
const OUTPUT = path.join(ROOT, 'programs/server/console_guide.json');
const SITE_PREFIX = '/products/web-console/';
const ROUTE_PREFIX = '/console/guide/';

class GuideError extends Error {}

function fail(where, message) {
    throw new GuideError(`${where}: ${message}`);
}

function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/// Text of the source, where Markdown allows character references such as `&amp;`: kept, not escaped twice.
function escapeText(text) {
    return text.replace(/&(?![a-z]+;|#[0-9]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTags(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/// --- Frontmatter ---

function parseFrontmatter(source, where) {
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) fail(where, 'no frontmatter');
    const fields = {};
    for (const line of match[1].split('\n')) {
        const field = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
        if (!field) fail(where, `unsupported frontmatter line: ${line}`);
        let value = field[2].trim();
        if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
        else if (/^".*"$/.test(value)) value = JSON.parse(value);
        fields[field[1]] = value;
    }
    for (const key of ['title', 'description']) {
        if (!fields[key]) fail(where, `no ${key} in the frontmatter`);
    }
    return {fields, body: source.slice(match[0].length)};
}

/// --- Inline content ---

/// `context.link(href)` returns the attributes of a link, or fails for a link to a missing page.
function renderInline(text, context) {
    const slots = [];
    const keep = html => `\u0000${slots.push(html) - 1}\u0000`;
    /// Code spans first: nothing inside them is Markdown.
    let out = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
        const content = code.length > 1 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code;
        return keep(`<code>${escapeHTML(content)}</code>`);
    });
    out = out.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, (_, ch) => keep(escapeHTML(ch)));
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => keep(`<a ${context.link(href)}>${renderInline(label, context)}</a>`));
    if (/<[A-Za-z/]/.test(out)) fail(context.where, `HTML or a component inside text: ${text.slice(0, 120)}`);
    out = escapeText(out);
    out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<em>$2</em>');
    if (/\*\*/.test(out)) fail(context.where, `unbalanced emphasis: ${text.slice(0, 120)}`);
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

/// --- Blocks ---

function indentOf(line) {
    return line.match(/^ */)[0].length;
}

function isBlank(line) {
    return line.trim() === '';
}

const FENCE = /^( *)(```+)(.*)$/;
const LIST_ITEM = /^( *)([-*]|\d+\.) +/;
const HEADING = /^(#{1,6}) +(.*?)\s*$/;
const COMPONENT_OPEN = /^<([A-Z][A-Za-z]*)((?: +[a-z]+="[^"]*")*) *>$/;
const COMPONENT_CLOSE = /^<\/([A-Z][A-Za-z]*)>$/;
const COMPONENTS = new Set(['Note', 'Tip', 'Warning', 'Steps', 'Step', 'Tabs', 'Tab']);
const CALLOUTS = {Note: 'Note', Tip: 'Tip', Warning: 'Warning'};

function startsBlock(line) {
    const trimmed = line.trimStart();
    return FENCE.test(line) || HEADING.test(trimmed) || LIST_ITEM.test(line) || trimmed.startsWith('|')
        || COMPONENT_OPEN.test(trimmed) || COMPONENT_CLOSE.test(trimmed);
}

function attributes(text) {
    const result = {};
    for (const [, key, value] of text.matchAll(/([a-z]+)="([^"]*)"/g)) result[key] = value;
    return result;
}

/// Removes `amount` spaces of indentation from each line (less from lines that have less).
function dedent(lines, amount) {
    return lines.map(line => line.slice(Math.min(amount, indentOf(line))));
}

/// Parses `lines` into HTML. `context` collects the headings and resolves links.
function renderBlocks(lines, context) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
            ++i;
            continue;
        }
        const trimmed = line.trim();

        const fence = line.match(FENCE);
        if (fence) {
            const indent = fence[1].length;
            const language = fence[3].trim();
            const body = [];
            ++i;
            while (i < lines.length && !(lines[i].trim() === fence[2] && indentOf(lines[i]) <= indent + 3)) body.push(lines[i++]);
            if (i === lines.length) fail(context.where, 'unclosed code block');
            ++i;
            const code = dedent(body, indent).join('\n');
            out.push(language === 'mermaid' ? renderMermaid(code, context) : renderCode(code, language));
            continue;
        }

        const open = trimmed.match(COMPONENT_OPEN);
        if (open) {
            const name = open[1];
            if (!COMPONENTS.has(name)) fail(context.where, `unsupported component <${name}>`);
            let depth = 1;
            let j = i + 1;
            for (; j < lines.length; ++j) {
                const t = lines[j].trim();
                if (FENCE.test(lines[j])) {
                    /// Skip code blocks: their text is not markup.
                    const marker = lines[j].match(FENCE)[2];
                    for (++j; j < lines.length && lines[j].trim() !== marker; ++j);
                    continue;
                }
                const o = t.match(COMPONENT_OPEN);
                const c = t.match(COMPONENT_CLOSE);
                if (o && o[1] === name) ++depth;
                if (c && c[1] === name && --depth === 0) break;
            }
            if (j === lines.length) fail(context.where, `<${name}> is not closed`);
            out.push(renderComponent(name, attributes(open[2]), dedent(lines.slice(i + 1, j), indentOf(line)), context));
            i = j + 1;
            continue;
        }
        if (COMPONENT_CLOSE.test(trimmed)) fail(context.where, `unexpected ${trimmed}`);

        const heading = trimmed.match(HEADING);
        if (heading) {
            const level = heading[1].length;
            let text = heading[2];
            const anchor = text.match(/\s*\{#([a-z0-9-]+)\}$/);
            let id;
            if (anchor) {
                id = anchor[1];
                text = text.slice(0, anchor.index);
            } else {
                fail(context.where, `heading without an anchor: ${trimmed}`);
            }
            if (level === 1) fail(context.where, 'a level 1 heading: the title of the page comes from the frontmatter');
            if (context.anchors.has(id)) fail(context.where, `duplicate anchor #${id}`);
            context.anchors.add(id);
            const html = renderInline(text, context);
            if (level <= 3) context.headings.push({id, level, text: stripTags(html)});
            out.push(`<h${level} id="${id}">${html}</h${level}>`);
            ++i;
            continue;
        }

        if (trimmed.startsWith('|') && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            const rows = [];
            while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim());
            out.push(renderTable(rows, context));
            continue;
        }

        if (LIST_ITEM.test(line)) {
            const [html, next] = renderList(lines, i, context);
            out.push(html);
            i = next;
            continue;
        }

        /// A paragraph: the lines up to a blank line or the start of another block.
        const paragraph = [trimmed];
        ++i;
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) paragraph.push(lines[i++].trim());
        out.push(`<p>${renderInline(paragraph.join('\n'), context)}</p>`);
    }
    return out.join('\n');
}

function renderList(lines, start, context) {
    const first = lines[start].match(LIST_ITEM);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let loose = false;
    let i = start;
    while (i < lines.length) {
        const marker = lines[i].match(LIST_ITEM);
        if (!marker || marker[1].length !== indent || /\d/.test(marker[2]) !== ordered) break;
        const content = marker[0].length;
        const body = [lines[i].slice(content)];
        ++i;
        while (i < lines.length) {
            const line = lines[i];
            if (isBlank(line)) {
                /// A blank line continues the item when the next text is indented as its content.
                let k = i;
                while (k < lines.length && isBlank(lines[k])) ++k;
                if (k < lines.length && indentOf(lines[k]) >= content) {
                    body.push(...lines.slice(i, k));
                    i = k;
                    continue;
                }
                break;
            }
            const indentation = indentOf(line);
            if (indentation >= content) {
                body.push(line.slice(content));
            } else if (indentation > indent && !LIST_ITEM.test(line) && !isBlank(lines[i - 1])) {
                body.push(line.trim());
            } else if (indentation <= indent && !startsBlock(line) && !isBlank(lines[i - 1])
                && !LIST_ITEM.test(lines[i - 1].slice(Math.min(indentOf(lines[i - 1]), indent)))) {
                /// A lazy continuation line of the item's paragraph.
                body.push(line.trim());
            } else {
                break;
            }
            ++i;
        }
        items.push(body);
        /// A blank line between items makes the list loose.
        let k = i;
        while (k < lines.length && isBlank(lines[k])) ++k;
        const next = k < lines.length ? lines[k].match(LIST_ITEM) : null;
        if (next && next[1].length === indent && /\d/.test(next[2]) === ordered) {
            if (k > i) loose = true;
            i = k;
        } else {
            break;
        }
    }
    const start_number = ordered ? Number(first[2].slice(0, -1)) : 1;
    const html = items.map(body => {
        let inner = renderBlocks(body, context);
        if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>(\n|$)/, '$1$2');
        return `<li>${inner}</li>`;
    }).join('\n');
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}${ordered && start_number !== 1 ? ` start="${start_number}"` : ''}>\n${html}\n</${tag}>`, i];
}

function splitRow(row) {
    const cells = [];
    let cell = '';
    let code = false;
    for (let i = 1; i < row.length; ++i) {
        const ch = row[i];
        if (ch === '\\' && row[i + 1] === '|') {
            cell += '|';
            ++i;
        } else if (ch === '`') {
            code = !code;
            cell += ch;
        } else if (ch === '|' && !code) {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += ch;
        }
    }
    if (cell.trim()) fail('table', `a row that does not end with |: ${row}`);
    return cells;
}

function renderTable(rows, context) {
    const head = splitRow(rows[0]);
    const align = splitRow(rows[1]).map(spec => spec.endsWith(':') ? (spec.startsWith(':') ? 'center' : 'right') : null);
    const cell = (tag, text, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${renderInline(text, context)}</${tag}>`;
    const body = rows.slice(2).map(row => {
        const cells = splitRow(row);
        if (cells.length !== head.length) fail(context.where, `a table row with ${cells.length} cells instead of ${head.length}: ${row.slice(0, 80)}`);
        return `<tr>${cells.map((text, k) => cell('td', text, k)).join('')}</tr>`;
    });
    return `<div class="guide-table"><table><thead><tr>${head.map((text, k) => cell('th', text, k)).join('')}</tr></thead>`
        + `<tbody>\n${body.join('\n')}\n</tbody></table></div>`;
}

function renderCode(code, language) {
    const label = language ? `<span class="guide-code-language">${escapeHTML(language)}</span>` : '';
    return `<div class="guide-code">${label}<pre><code${language ? ` class="language-${escapeHTML(language)}"` : ''}>${escapeHTML(code)}</code></pre></div>`;
}

/// A Mermaid flowchart as a table of its connections: the console loads no diagram library.
function renderMermaid(code, context) {
    const lines = code.split('\n').map(line => line.trim()).filter(Boolean);
    if (!/^(flowchart|graph) /.test(lines[0])) fail(context.where, `unsupported Mermaid diagram: ${lines[0]}`);
    const labels = new Map();
    const node = text => {
        const match = text.trim().match(/^([A-Za-z0-9_]+)(?:\["([^"]*)"\])?$/);
        if (!match) fail(context.where, `unsupported Mermaid node: ${text}`);
        if (match[2] !== undefined) labels.set(match[1], match[2]);
        return match[1];
    };
    const edges = [];
    for (const line of lines.slice(1)) {
        const match = line.match(/^(.+?)\s+(?:--\s+"([^"]*)"\s+-->|-->|---)\s+(.+)$/);
        if (!match) fail(context.where, `unsupported Mermaid line: ${line}`);
        edges.push({from: node(match[1]), label: match[2] || '', to: node(match[3]), directed: !line.includes('---')});
    }
    const name = id => escapeHTML(labels.get(id) || id);
    const rows = edges.map(e => `<tr><td>${name(e.from)}</td><td aria-label="${e.directed ? 'to' : 'with'}">${e.directed ? '→' : '—'}</td>`
        + `<td>${name(e.to)}</td><td>${escapeHTML(e.label)}</td></tr>`);
    return '<figure class="guide-diagram"><figcaption>Connections between the components</figcaption><div class="guide-table"><table>'
        + '<thead><tr><th>From</th><th></th><th>To</th><th>What</th></tr></thead>'
        + `<tbody>\n${rows.join('\n')}\n</tbody></table></div></figure>`;
}

function renderComponent(name, attrs, lines, context) {
    if (CALLOUTS[name]) {
        return `<aside class="guide-callout guide-${name.toLowerCase()}"><p class="guide-callout-title">${CALLOUTS[name]}</p>\n${renderBlocks(lines, context)}\n</aside>`;
    }
    if (name === 'Steps' || name === 'Tabs') {
        const child = name === 'Steps' ? 'Step' : 'Tab';
        const children = [];
        for (let i = 0; i < lines.length; ++i) {
            const t = lines[i].trim();
            if (isBlank(t)) continue;
            const open = t.match(COMPONENT_OPEN);
            if (!open || open[1] !== child) fail(context.where, `<${name}> contains something else than <${child}>: ${t}`);
            let depth = 1;
            let j = i + 1;
            for (; j < lines.length; ++j) {
                if (FENCE.test(lines[j])) {
                    const marker = lines[j].match(FENCE)[2];
                    for (++j; j < lines.length && lines[j].trim() !== marker; ++j);
                    continue;
                }
                const lt = lines[j].trim();
                const o = lt.match(COMPONENT_OPEN);
                const c = lt.match(COMPONENT_CLOSE);
                if (o && o[1] === child) ++depth;
                if (c && c[1] === child && --depth === 0) break;
            }
            const title = attributes(open[2]).title;
            if (!title) fail(context.where, `<${child}> without a title`);
            children.push({title, html: renderBlocks(lines.slice(i + 1, j), context)});
            i = j;
        }
        if (name === 'Steps') {
            return '<ol class="guide-steps">\n' + children.map(s =>
                `<li><p class="guide-step-title">${renderInline(s.title, context)}</p>\n${s.html}\n</li>`).join('\n') + '\n</ol>';
        }
        const group = `tabs-${context.key.replace(/[^a-z0-9]+/g, '-')}-${++context.tab_groups}`;
        const tabs = children.map((t, k) => `<button type="button" role="tab" id="${group}-${k}" aria-controls="${group}-${k}-panel" `
            + `aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">${renderInline(t.title, context)}</button>`).join('');
        const panels = children.map((t, k) => `<div role="tabpanel" id="${group}-${k}-panel" aria-labelledby="${group}-${k}"${k ? ' hidden' : ''}>\n${t.html}\n</div>`).join('\n');
        return `<div class="guide-tabs"><div role="tablist">${tabs}</div>\n${panels}\n</div>`;
    }
    fail(context.where, `<${name}> outside of its parent component`);
}

/// --- Pages ---

function pageKeyOfSitePath(page) {
    if (!page.startsWith(SITE_PREFIX.slice(1))) throw new GuideError(`navigation.json: ${page} is not under ${SITE_PREFIX}`);
    return page.slice(SITE_PREFIX.length - 1);
}

function readNavigation() {
    const navigation = JSON.parse(fs.readFileSync(path.join(SOURCE, 'navigation.json'), 'utf8'));
    const groups = [];
    let loose = null;
    for (const entry of navigation.pages) {
        if (typeof entry === 'string') {
            if (!loose) {
                loose = {title: null, pages: []};
                groups.push(loose);
            }
            loose.pages.push(pageKeyOfSitePath(entry));
        } else {
            if (entry.pages.some(p => typeof p !== 'string')) throw new GuideError(`navigation.json: nested groups in ${entry.group}`);
            groups.push({title: entry.group, pages: entry.pages.map(pageKeyOfSitePath)});
            loose = null;
        }
    }
    return {title: navigation.item, groups};
}

export function buildGuide() {
    const navigation = readNavigation();
    const keys = navigation.groups.flatMap(g => g.pages);
    const files = fs.readdirSync(SOURCE, {recursive: true}).filter(f => f.endsWith('.mdx')).map(f => f.split(path.sep).join('/').slice(0, -4)).sort();
    const missing = files.filter(f => !keys.includes(f));
    if (missing.length) throw new GuideError(`pages not in navigation.json: ${missing.join(', ')}`);

    const pending_links = [];
    const pages = {};
    for (const key of keys) {
        const where = `docs/products/web-console/${key}.mdx`;
        const file = path.join(SOURCE, `${key}.mdx`);
        if (!fs.existsSync(file)) throw new GuideError(`navigation.json: no page ${key}`);
        const {fields, body} = parseFrontmatter(fs.readFileSync(file, 'utf8'), where);
        const context = {
            key, where, headings: [], anchors: new Set(), tab_groups: 0,
            link(href) {
                if (href.startsWith('#')) {
                    pending_links.push({where, page: key, anchor: href.slice(1)});
                    return `href="${escapeHTML(href)}"`;
                }
                if (href.startsWith(SITE_PREFIX)) {
                    const [target, anchor] = href.slice(SITE_PREFIX.length).split('#');
                    pending_links.push({where, page: target, anchor});
                    return `href="${ROUTE_PREFIX}${escapeHTML(href.slice(SITE_PREFIX.length))}" data-route=""`;
                }
                if (href.startsWith('/')) return `href="https://clickhouse.com/docs${escapeHTML(href)}" data-docs="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"`;
                if (/^https?:\/\//.test(href)) return `href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"`;
                fail(where, `unsupported link ${href}`);
            },
        };
        const html = renderBlocks(body.split('\n'), context);
        pages[key] = {
            title: fields.title,
            sidebar_title: fields.sidebarTitle || fields.title,
            description: fields.description,
            headings: context.headings,
            html,
            anchors: [...context.anchors],
        };
    }
    for (const link of pending_links) {
        const target = pages[link.page];
        if (!target) throw new GuideError(`${link.where}: a link to a missing page ${link.page}`);
        if (link.anchor && !target.anchors.includes(link.anchor)) throw new GuideError(`${link.where}: a link to a missing anchor ${link.page}#${link.anchor}`);
    }
    for (const page of Object.values(pages)) delete page.anchors;
    return {
        /// Generated by utils/web-console/build_guide.mjs from docs/products/web-console: do not edit.
        generator: 'utils/web-console/build_guide.mjs',
        source: 'docs/products/web-console',
        title: navigation.title,
        groups: navigation.groups,
        pages,
    };
}

function main() {
    const check = process.argv.includes('--check');
    let text;
    try {
        text = JSON.stringify(buildGuide(), null, 1) + '\n';
    } catch (e) {
        if (!(e instanceof GuideError)) throw e;
        console.error(`build_guide: ${e.message}`);
        process.exit(1);
    }
    if (check) {
        const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
        if (current !== text) {
            console.error(`build_guide: ${path.relative(ROOT, OUTPUT)} is not up to date: run node utils/web-console/build_guide.mjs`);
            process.exit(1);
        }
        console.log(`build_guide: ${path.relative(ROOT, OUTPUT)} is up to date`);
        return;
    }
    fs.writeFileSync(OUTPUT, text);
    console.log(`build_guide: wrote ${path.relative(ROOT, OUTPUT)} (${Object.keys(JSON.parse(text).pages).length} pages, ${text.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
