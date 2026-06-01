// Minimal markdown renderer for the note editor preview.
// Uses `marked` (already a dependency) to tokenize, then maps tokens to
// React Native primitives. Mirrors the typography of the frontend
// Milkdown editor so the mobile preview matches the web feel.
//
// Optional in-page search: pass `searchQuery` and `activeMatchIndex` to
// highlight occurrences. When `scrollRef` is provided, the block holding
// the active match is scrolled into view as `activeMatchIndex` changes.

import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fileNameFromUrl, isAttachmentUrl } from '../utils/attachments';
import { colors } from '../utils/theme';
import { AttachmentView, ImageBlock } from './markdown';

marked.use({ gfm: true, breaks: false });

// Resolve a list item's task state and the content tokens to render.
//
// For a proper GFM task item (`- [ ] foo`), `marked` emits a dedicated
// `checkbox` token at the head of `item.tokens` AND sets `item.task`. We draw
// our own ☐/☑ glyph from the task state, so that `checkbox` token must be
// filtered out of the content — otherwise its raw "[ ]" renders as literal
// text on its own line ("☐ [ ] foo").
//
// As a fallback, LLM output sometimes leaves a checkbox as plain text (e.g. a
// loose list or a checkbox split from its label across lines) that the parser
// doesn't flag as a task. We detect a leading "[ ]" in the item text, strip
// it, and treat the item as a task.
const normalizeListItem = (item) => {
  const baseTokens = Array.isArray(item.tokens) ? item.tokens : [];
  const checkboxToken = baseTokens.find((t) => t.type === 'checkbox');
  if (item.task === true || checkboxToken) {
    return {
      isTask: true,
      checked: item.task === true ? item.checked === true : checkboxToken?.checked === true,
      tokens: baseTokens.filter((t) => t.type !== 'checkbox'),
    };
  }
  const rawText = typeof item.text === 'string' ? item.text : '';
  const stripped = rawText.replace(/^\s*\[[ xX]\]\s*/, '');
  if (stripped !== rawText) {
    return { isTask: true, checked: /^\s*\[[xX]\]/.test(rawText), tokens: marked.lexer(stripped) };
  }
  return { isTask: false, checked: false, tokens: baseTokens };
};

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  body: { paddingBottom: 24 },
  paragraph: { color: colors.text, fontSize: 16, lineHeight: 24, marginBottom: 12 },
  h1: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 6,
  },
  h2: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 14, marginBottom: 10 },
  h3: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 12, marginBottom: 8 },
  h4: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 10, marginBottom: 6 },
  h5: { color: colors.text, fontSize: 15, fontWeight: '600' },
  h6: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: colors.muted },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  codeInline: {
    fontFamily: mono,
    fontSize: 14,
    color: colors.accent2,
    backgroundColor: colors.bgSoft,
  },
  codeBlock: {
    backgroundColor: colors.bgSoft,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    marginVertical: 10,
    overflow: 'hidden',
    borderLeftWidth: 3,
    borderLeftColor: colors.accent2,
  },
  codeBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.panel,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  codeBlockLang: {
    color: colors.accent2,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  codeBlockDots: {
    flexDirection: 'row',
    gap: 5,
  },
  codeBlockDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  codeBlockScroll: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  codeBlockText: { color: colors.text, fontFamily: mono, fontSize: 13, lineHeight: 18 },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  blockquote: {
    backgroundColor: colors.bgSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 8,
  },
  listItemRow: { flexDirection: 'row', marginBottom: 4, alignItems: 'flex-start' },
  listBullet: { color: colors.muted, width: 24, fontSize: 16, lineHeight: 22 },
  listTask: { color: colors.accent2, width: 24, fontSize: 18, lineHeight: 22 },
  listContent: { flex: 1 },
  listItemText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  tableScroll: { marginVertical: 8 },
  tableWrap: {
    flexDirection: 'column',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.bgSoft,
  },
  tableRow: { flexDirection: 'row' },
  tableHeaderRow: { backgroundColor: colors.panel },
  tableCell: {
    width: 200,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  tableCellLast: { borderRightWidth: 0 },
  tableCellText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  tableHeaderText: { color: colors.text, fontWeight: '700', fontSize: 14, lineHeight: 20 },
  match: { backgroundColor: 'rgba(247, 201, 72, 0.35)', color: colors.text },
  matchActive: { backgroundColor: colors.accent, color: colors.bg },
});

// True when a paragraph's inline tokens include an image or an attachment link
// — those must render as block-level Views (an Image / box can't nest in Text).
const containsMedia = (tokens) =>
  Array.isArray(tokens) &&
  tokens.some(
    (t) => t.type === 'image' || (t.type === 'link' && isAttachmentUrl(t.href)),
  );

// Renders a paragraph that mixes text with media: text runs become <Text>,
// image/attachment tokens become standalone blocks, in document order.
const renderMediaParagraph = (tokens, textStyle, ctx, key) => {
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length) {
      blocks.push(
        <Text key={`${key}-t${blockKey++}`} style={textStyle}>
          {renderInlineTokens(buffer, textStyle, ctx)}
        </Text>,
      );
      buffer = [];
    }
  };
  for (const t of tokens) {
    if (t.type === 'image') {
      flush();
      blocks.push(<ImageBlock key={`${key}-img${blockKey++}`} uri={t.href} alt={t.text} />);
    } else if (t.type === 'link' && isAttachmentUrl(t.href)) {
      flush();
      blocks.push(
        <AttachmentView
          key={`${key}-att${blockKey++}`}
          url={t.href}
          label={t.text || fileNameFromUrl(t.href)}
        />,
      );
    } else {
      buffer.push(t);
    }
  }
  flush();
  return <View key={key}>{blocks}</View>;
};

const headingStyles = [styles.h1, styles.h2, styles.h3, styles.h4, styles.h5, styles.h6];

const splitTextWithMatches = (text, q) => {
  if (!q) return [{ text, isMatch: false }];
  const lc = text.toLowerCase();
  const lq = q.toLowerCase();
  const parts = [];
  let i = 0;
  while (i < text.length) {
    const j = lc.indexOf(lq, i);
    if (j === -1) {
      if (i < text.length) parts.push({ text: text.slice(i), isMatch: false });
      break;
    }
    if (j > i) parts.push({ text: text.slice(i, j), isMatch: false });
    parts.push({ text: text.slice(j, j + q.length), isMatch: true });
    i = j + q.length;
  }
  return parts;
};

// Render-time mutable state (reset on every render).
let inlineKey = 0;
let blockKey = 0;
let matchCounter = 0;

const renderInlineTokens = (tokens, baseStyle, ctx) => {
  if (!tokens) return null;
  const out = [];
  for (const t of tokens) {
    const k = `i-${inlineKey++}`;
    switch (t.type) {
      case 'text': {
        if (t.tokens) {
          out.push(
            <Text key={k} style={baseStyle}>
              {renderInlineTokens(t.tokens, baseStyle, ctx)}
            </Text>,
          );
        } else if (ctx.searchQuery) {
          const parts = splitTextWithMatches(t.text || '', ctx.searchQuery);
          parts.forEach((p, idx) => {
            const pk = `${k}-${idx}`;
            if (p.isMatch) {
              const mi = matchCounter++;
              if (ctx.blockRange) ctx.blockRange.end = mi + 1;
              const active = mi === ctx.activeMatchIndex;
              out.push(
                <Text key={pk} style={[baseStyle, active ? styles.matchActive : styles.match]}>
                  {p.text}
                </Text>,
              );
            } else {
              out.push(
                <Text key={pk} style={baseStyle}>
                  {p.text}
                </Text>,
              );
            }
          });
        } else {
          out.push(
            <Text key={k} style={baseStyle}>
              {t.text}
            </Text>,
          );
        }
        break;
      }
      case 'strong':
        out.push(
          <Text key={k} style={[baseStyle, styles.strong]}>
            {renderInlineTokens(t.tokens, [baseStyle, styles.strong], ctx)}
          </Text>,
        );
        break;
      case 'em':
        out.push(
          <Text key={k} style={[baseStyle, styles.em]}>
            {renderInlineTokens(t.tokens, [baseStyle, styles.em], ctx)}
          </Text>,
        );
        break;
      case 'del':
        out.push(
          <Text key={k} style={[baseStyle, styles.del]}>
            {renderInlineTokens(t.tokens, [baseStyle, styles.del], ctx)}
          </Text>,
        );
        break;
      case 'codespan': {
        if (ctx.searchQuery) {
          const parts = splitTextWithMatches(t.text || '', ctx.searchQuery);
          const inner = parts.map((p, idx) => {
            const pk = `${k}-${idx}`;
            if (p.isMatch) {
              const mi = matchCounter++;
              if (ctx.blockRange) ctx.blockRange.end = mi + 1;
              const active = mi === ctx.activeMatchIndex;
              return (
                <Text key={pk} style={active ? styles.matchActive : styles.match}>
                  {p.text}
                </Text>
              );
            }
            return <Text key={pk}>{p.text}</Text>;
          });
          out.push(
            <Text key={k} style={[baseStyle, styles.codeInline]}>
              {' '}{inner}{' '}
            </Text>,
          );
        } else {
          out.push(
            <Text key={k} style={[baseStyle, styles.codeInline]}>
              {' '}{t.text}{' '}
            </Text>,
          );
        }
        break;
      }
      case 'link':
        out.push(
          <Text
            key={k}
            style={[baseStyle, styles.link]}
            onPress={() => Linking.openURL(t.href).catch(() => {})}
          >
            {renderInlineTokens(t.tokens, [baseStyle, styles.link], ctx)}
          </Text>,
        );
        break;
      case 'br':
        out.push(<Text key={k}>{'\n'}</Text>);
        break;
      case 'escape':
        out.push(
          <Text key={k} style={baseStyle}>
            {t.text}
          </Text>,
        );
        break;
      case 'image':
        out.push(
          <Text key={k} style={[baseStyle, styles.codeInline]}>
            [image: {t.text || t.href}]
          </Text>,
        );
        break;
      default:
        out.push(
          <Text key={k} style={baseStyle}>
            {t.raw || t.text || ''}
          </Text>,
        );
    }
  }
  return out;
};

const wrapBlock = (key, children, ctx) => {
  const start = matchCounter;
  const range = { start, end: start };
  const inner = children(range);
  const end = matchCounter;
  if (ctx.searchQuery && end > start) {
    const bk = `mb-${blockKey++}`;
    ctx.blockRanges.push({ blockKey: bk, start, end });
    return (
      <View
        key={key}
        onLayout={(e) => {
          ctx.blockYMap.set(bk, e.nativeEvent.layout.y);
        }}
      >
        {inner}
      </View>
    );
  }
  return inner;
};

const renderBlockToken = (token, depth, ctx) => {
  const key = `b-${blockKey++}`;
  switch (token.type) {
    case 'heading': {
      const baseStyle = headingStyles[Math.min(token.depth - 1, 5)];
      const style = ctx.textStyle ? [baseStyle, ctx.textStyle] : baseStyle;
      return wrapBlock(key, () => (
        <Text key={`${key}-t`} style={style}>
          {renderInlineTokens(token.tokens, style, ctx)}
        </Text>
      ), ctx);
    }
    case 'paragraph': {
      const style = ctx.textStyle
        ? [styles.paragraph, ctx.textStyle]
        : styles.paragraph;
      // Paragraphs holding images / attachment links render as mixed blocks
      // (an Image or box can't sit inside a <Text>).
      if (containsMedia(token.tokens)) {
        return renderMediaParagraph(token.tokens, style, ctx, key);
      }
      return wrapBlock(key, () => (
        <Text key={`${key}-t`} style={style}>
          {renderInlineTokens(token.tokens, style, ctx)}
        </Text>
      ), ctx);
    }
    case 'hr':
      return <View key={key} style={styles.hr} />;
    case 'space':
      return null;
    case 'code': {
      // Lang label for the header chip. Empty fenced blocks show "text"; a
      // block of pure tree-drawing chars gets a friendlier "tree" hint so the
      // architecture diagrams in the plan notes read as a folder structure.
      const rawLang = (token.lang || '').trim().toLowerCase();
      const looksLikeTree =
        !rawLang && /[├└│─]/.test(token.text || '');
      const langLabel = rawLang || (looksLikeTree ? 'tree' : 'text');
      const Header = (
        <View style={styles.codeBlockHeader}>
          <View style={styles.codeBlockDots}>
            <View
              style={[styles.codeBlockDot, { backgroundColor: colors.accent3 }]}
            />
            <View
              style={[styles.codeBlockDot, { backgroundColor: colors.accent }]}
            />
            <View
              style={[styles.codeBlockDot, { backgroundColor: colors.accent2 }]}
            />
          </View>
          <Text style={styles.codeBlockLang}>{langLabel}</Text>
        </View>
      );
      if (ctx.searchQuery) {
        return wrapBlock(
          key,
          () => {
            const parts = splitTextWithMatches(token.text || '', ctx.searchQuery);
            return (
              <View key={`${key}-t`} style={styles.codeBlock}>
                {Header}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator
                  contentContainerStyle={styles.codeBlockScroll}
                >
                  <Text style={styles.codeBlockText}>
                    {parts.map((p) => {
                      const pk = `${key}-p${inlineKey++}`;
                      if (p.isMatch) {
                        const mi = matchCounter++;
                        const active = mi === ctx.activeMatchIndex;
                        return (
                          <Text
                            key={pk}
                            style={active ? styles.matchActive : styles.match}
                          >
                            {p.text}
                          </Text>
                        );
                      }
                      return <Text key={pk}>{p.text}</Text>;
                    })}
                  </Text>
                </ScrollView>
              </View>
            );
          },
          ctx,
        );
      }
      return (
        <View key={key} style={styles.codeBlock}>
          {Header}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeBlockScroll}
          >
            <Text style={styles.codeBlockText}>{token.text}</Text>
          </ScrollView>
        </View>
      );
    }
    case 'blockquote':
      return (
        <View key={key} style={styles.blockquote}>
          {token.tokens?.map((t) => renderBlockToken(t, depth + 1, ctx))}
        </View>
      );
    case 'list': {
      const bulletStyle = ctx.textStyle
        ? [styles.listBullet, ctx.textStyle]
        : styles.listBullet;
      const itemStyle = ctx.textStyle
        ? [styles.listItemText, ctx.textStyle]
        : styles.listItemText;
      const taskStyle = ctx.textStyle
        ? [styles.listTask, ctx.textStyle]
        : styles.listTask;
      return (
        <View key={key} style={{ marginBottom: 8 }}>
          {token.items.map((item, idx) => {
            const liKey = `li-${blockKey++}`;
            // GFM task items: render a checkbox glyph in place of the bullet.
            // Otherwise fall back to numbered/bulleted as usual.
            const { isTask, checked, tokens: itemTokens } = normalizeListItem(item);
            const marker = isTask
              ? checked
                ? '☑'
                : '☐'
              : token.ordered
                ? `${idx + 1}.`
                : '•';
            return (
              <View key={liKey} style={styles.listItemRow}>
                <Text style={isTask ? taskStyle : bulletStyle}>{marker}</Text>
                <View style={styles.listContent}>
                  {itemTokens?.map((t) =>
                    t.type === 'text' || t.type === 'paragraph'
                      ? wrapBlock(`it-${blockKey++}`, () => (
                          <Text key={`it-t-${blockKey}`} style={itemStyle}>
                            {renderInlineTokens(
                              t.tokens || [{ type: 'text', text: t.text }],
                              itemStyle,
                              ctx,
                            )}
                          </Text>
                        ), ctx)
                      : renderBlockToken(t, depth + 1, ctx),
                  )}
                </View>
              </View>
            );
          })}
        </View>
      );
    }
    case 'html':
      return (
        <Text
          key={key}
          style={ctx.textStyle ? [styles.paragraph, ctx.textStyle] : styles.paragraph}
        >
          {(token.text || '').replace(/<[^>]+>/g, '')}
        </Text>
      );
    case 'table': {
      const rows = [token.header, ...token.rows];
      return (
        <ScrollView
          key={key}
          horizontal
          showsHorizontalScrollIndicator
          style={styles.tableScroll}
          contentContainerStyle={styles.tableWrap}
        >
          {rows.map((row, ri) => {
            const rowKey = `r-${blockKey++}`;
            const isHeader = ri === 0;
            return (
              <View
                key={rowKey}
                style={[
                  styles.tableRow,
                  isHeader && styles.tableHeaderRow,
                  !isHeader && { borderTopWidth: 1, borderTopColor: colors.border },
                ]}
              >
                {row.map((cell, ci) => {
                  const cellKey = `c-${blockKey++}`;
                  const isLast = ci === row.length - 1;
                  const baseCellStyle = isHeader
                    ? styles.tableHeaderText
                    : styles.tableCellText;
                  const cellTextStyle = ctx.textStyle
                    ? [baseCellStyle, ctx.textStyle]
                    : baseCellStyle;
                  return (
                    <View key={cellKey} style={[styles.tableCell, isLast && styles.tableCellLast]}>
                      <Text style={cellTextStyle}>
                        {cell.tokens
                          ? renderInlineTokens(cell.tokens, cellTextStyle, ctx)
                          : cell.text}
                      </Text>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </ScrollView>
      );
    }
    default:
      return (
        <Text
          key={key}
          style={ctx.textStyle ? [styles.paragraph, ctx.textStyle] : styles.paragraph}
        >
          {token.raw || ''}
        </Text>
      );
  }
};

export default function MarkdownView({
  source,
  searchQuery = '',
  activeMatchIndex = 0,
  scrollRef,
  onMatchCountChange,
  textStyle,
}) {
  const blockYMap = useRef(new Map()).current;
  const blockRangesRef = useRef([]);

  const tokens = useMemo(() => {
    if (!source) return [];
    try {
      return marked.lexer(source);
    } catch {
      return null;
    }
  }, [source]);

  // Reset render-time counters before walking the tree.
  inlineKey = 0;
  blockKey = 0;
  matchCounter = 0;
  const blockRanges = [];
  const ctx = { searchQuery, activeMatchIndex, blockRanges, blockYMap, textStyle };

  let body = null;
  if (tokens === null) {
    body = (
      <Text style={textStyle ? [styles.paragraph, textStyle] : styles.paragraph}>
        {source}
      </Text>
    );
  } else {
    body = tokens.map((t) => renderBlockToken(t, 0, ctx));
  }

  const totalMatches = matchCounter;
  blockRangesRef.current = blockRanges;
  const lastCountRef = useRef(-1);

  // Notify parent only when the count actually changes.
  useEffect(() => {
    if (lastCountRef.current !== totalMatches) {
      lastCountRef.current = totalMatches;
      onMatchCountChange?.(totalMatches);
    }
  });

  // Scroll the active match's block into view whenever the active match moves.
  useEffect(() => {
    if (!scrollRef?.current) return;
    const range = blockRangesRef.current.find(
      (r) => activeMatchIndex >= r.start && activeMatchIndex < r.end,
    );
    if (!range) return;
    const y = blockYMap.get(range.blockKey);
    if (y == null) return;
    scrollRef.current.scrollTo({ y: Math.max(0, y - 40), animated: true });
  }, [activeMatchIndex, scrollRef, blockYMap]);

  if (!source) return null;
  return <View style={styles.body}>{body}</View>;
}
