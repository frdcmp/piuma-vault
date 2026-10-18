# `@/ui` — the Pv component kit

Every button, field, dialog, table and menu in the web app comes from here:

```js
import { PvButton, PvField, PvInput, PvModal, pvMessage } from "@/ui";
```

**Rules**

- No raw `<button>`, `<input>`, `<select>`, `<textarea>` in features: use the component below. (Exceptions: inputs inside a third-party editor's DOM, and the hidden `<input type="file">` inside `PvUpload`.)
- No antd. Icons from `@ant-design/icons` are fine.
- Colours, fonts, radii and shadows only through the `--vp-*` tokens (`src/theme/tokens.json`). `bun run theme:lint` fails on any literal colour outside `src/theme/`.
- A component's CSS lives next to it and uses only tokens. Shared looks (`.vp-input`, `.vp-panel`, `.vp-btn` …) live in `src/theme/vault-pixel.css`.
- Missing a primitive? Add it here (folder + `index.js` + barrel line + a row below), don't inline one in a page.

## Components

| Component | Purpose | Key props |
| --- | --- | --- |
| `PvButton` | Action / link button | `variant` default·primary·danger·accent·ghost, `size` md·sm, `block`, `loading`, `icon`, `to` (router), `href` |
| `PvInput` | Text input (`.vp-input`) | native input props, `size`, `invalid`, `prefix`, `suffix`, `reveal` (password show/hide) |
| `PvTextarea` | Multi-line input | native props, `autoSize`, `invalid` |
| `PvSelect` | Native dropdown | `options` [{value,label}]·string[], `value`, `onChange(value)`, `placeholder`, `allowClear`, `size`, `invalid` |
| `PvField` | Label + control + hint/error | `label`, `hint`, `error`, `required`, children = control |
| `PvCheckbox` | Checkbox | `checked`, `onChange(checked)`, `label`, `disabled` |
| `PvSwitch` | On/off toggle | `checked`, `onChange(checked)`, `label`, `size`, `loading` |
| `PvSegmented` | One-of-N button row | `options`, `value`, `onChange(value)`, `size`, `block` |
| `PvDateTimePicker` | Date / time / datetime picker | `value`, `onChange`, `mode` date·time·datetime, `placeholder`, `clearable` |
| `PvUpload` | File picker / drop zone | `onFiles(File[])`, `accept`, `multiple`, `drag`, `disabled` |
| `PvPanel` | The workhorse container (title bar with pixel dots) | `title`, `extra`, `noPad`, `bodyClassName` |
| `PvTabs` | Tab strip + active panel | `items` [{key,label,children}], `activeKey`·`defaultActiveKey`, `onChange`, `extra` |
| `PvTable` | Data table | `columns` [{key,title,dataIndex,render,width,align,sorter}], `data`, `rowKey`, `loading`, `emptyText`, `onRowClick`, `size`, `minWidth`, `pagination` {pageSize,hideOnSinglePage}, `expandable` {expandedRowRender,rowExpandable} |
| `PvExpander` | Pixel +/− row toggle (used by `PvTable` expandable rows) | `expanded`, `onExpand(record, e)`, `record` |
| `PvTag` | Chip | `color`, `onClick`, `onRemove` |
| `PvAvatar` | Square avatar | `src`, `size`, `tone` accent·success·danger·info·violet·muted, children = initials |
| `PvEmpty` | Empty state | `description`, `icon`, `compact`, children = action |
| `PvSpin` | Inline spinner | `label`, `block` |
| `PvAlert` | Inline message box | `type` info·success·warning·error, `title`, `onClose` |
| `PvTooltip` | Hover/focus tooltip | `title`, `placement` top·bottom·left·right |
| `PvModal` | Dialog | `open`, `title`, `onConfirm`, `onCancel`, `confirmText`, `cancelText`, `danger`, `footer`, `width`, `showClose`, `dismissOnOverlay` |
| `PvPopconfirm` | "Are you sure?" bubble on a trigger | `title`, `description`, `onConfirm`, `okText`, `cancelText`, `okVariant` (default danger), `align` |
| `PvPopover` | Anchored floating panel | `open`, `anchorRef`, `onClose`, `width` |
| `PvMenu` | Context menu | `open`, `x`, `y`, `items`, `onClose` |
| `PvDrawer` | Side panel | `open`, `onClose`, `placement` left·right, `width`, `title` |
| `PvAlarm` | Ringing alarm card | `open`, `kind`, `title`, `timeText`, `body`, `snoozeOptions`, `onSnooze(min)`, `onDismiss` |
| `LockGlyph` | Pixel padlock icon | `open`, `size` |
| `pvMessage` | Toast line | `.success/.error/.info/.warning(text, ms)` → id, `.dismiss(id)` |
| `pvToast` | Progress toast | `pvToast.show({ label, progress })` → `{ update({label, progress}), success(label), error(label), dismiss() }` |

## Theming

Edit `src/theme/tokens.json`, run `bun run theme:build` (also runs before `dev`/`build`). In JS (canvas, charts) read colours with `useTheme().tokens` (or `currentTokens()` outside React) — never copy a hex. Translucent tints: `color-mix(in srgb, var(--vp-accent) 12%, transparent)`.
