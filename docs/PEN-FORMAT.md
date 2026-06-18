# The `.pen` File Format

> Resolves audit finding **P1-A** (`docs/AUDIT-2026-06-12.md`): the "`.pen` is
> encrypted" guardrail was **false**. `.pen` files are plaintext JSON.

## Summary

`.pen` files are **plaintext JSON**, not encrypted. This is Pencil's documented,
developer-facing format — the spec page exists explicitly "for developers who
would like to read or write `.pen` files."

- Read directly with `readFile` + `JSON.parse`. No decryption, no mandatory API.
- `Read` / `Grep` on `.pen` files is **safe** (the old "never Read/Grep" rule was wrong).
- The Pencil MCP server is **optional** — preferred for *structured writes*
  (code-to-pen) and screenshot validation, not because the file is encrypted.

Sources:
- [The .pen Format — Pencil docs](https://docs.pencil.dev/for-developers/the-pen-format)
- [.pen Files — Pencil docs](https://docs.pencil.dev/core-concepts/pen-files)

## Document shape

The top-level object is a `Document`:

```json
{
  "version": "2.13",
  "themes":    { "...": "..." },
  "imports":   { "...": "..." },
  "variables": { "...": "..." },
  "children":  [ /* root objects */ ]
}
```

`children` holds the object tree. `variables` and `themes` hold design tokens
(colors, typography, spacing) — the source of truth for the color fast-path.

## Object schema

Every object (node) has:

| Field | Type | Notes |
|---|---|---|
| `id` | string | unique; must not contain `/` |
| `type` | string | `rectangle`, `frame`, `text`, `ellipse`, `path`, `polygon`, `group`, `ref`, `icon`, `script`, `note`, `prompt`, `context` |
| `name` | string? | optional display name |
| `x`, `y` | number | position |
| `width`, `height` | number \| string | fixed, or sizing behavior (e.g. `"fit_content"`) |

Graphics:

| Field | Type | Notes |
|---|---|---|
| `fill` | string \| object \| array | color string, **gradient object**, image, or **array of fills** |
| `stroke` | fill(s) | same value shapes as `fill` |
| `strokeWidth` | number \| per-side | |
| `cornerRadius` | number \| `[t,r,b,l]` | single value **or array** |

Text (`type: "text"`):

| Field | Type |
|---|---|
| `content` | string (the text) |
| `fontFamily` | string |
| `fontSize` | number |
| `fontWeight` | string \| number |
| `textAlign` | `left` \| `center` \| `right` \| `justify` |

Containers:

| Field | Type | Notes |
|---|---|---|
| `children` | array | child objects (frames, groups) |
| `layout` | string | `none` \| `vertical` \| `horizontal` |
| `reusable` | boolean | marks a reusable component |

## What pencil-sync currently tracks

`src/pen-snapshot.ts` flattens the tree and snapshots these props per node
(`TRACKED_PROPS`): `fill`, `content`, `fontSize`, `fontWeight`, `fontFamily`,
`cornerRadius` (plus `name` and `type` as identity). Field **names** match the
real schema.

## Known gaps vs. the real schema

The current parser was validated only against synthetic `JSON.stringify({...})`
fixtures. Against real `.pen` files it has these gaps (see follow-up plan):

1. **`fill` as object/array** — gradient objects, images, and fill arrays are
   stored as scalars and compared via `String(x)`, collapsing to
   `"[object Object]"`. Distinct gradients/images read as equal → diffs missed.
2. **`cornerRadius` as `[t,r,b,l]`** — same `String()` collapse; per-side radius
   changes are missed.
3. **`variables` / `themes` ignored** — the design-token source the color
   fast-path actually depends on is never read from the document.
4. **`ref` / `reusable` components** — recursion only walks literal `children`;
   reused component instances are not resolved.
