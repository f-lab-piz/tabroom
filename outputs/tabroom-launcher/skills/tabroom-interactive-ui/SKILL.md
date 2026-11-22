---
name: tabroom-interactive-ui
description: Use when a Tabroom reply benefits from adjustable values, interactive comparisons, or selectable options.
---

# Tabroom interactive responses

Reusable response capability for text-producing agents. Use normal Markdown for explanations, and a `tabroom-ui` JSON block only when the user benefits from inspecting data, choosing options, changing values, or acting on a result. Keep the essential result readable in prose. Visible labels should use the user's language.

## Message format

Emit Markdown and then a fenced block labeled exactly `tabroom-ui`. Emit JSON inside, beginning with `{"version":1,"state":{},"nodes":[]}` and replace the empty `nodes` with your components. The block activates when the assistant message completes. It can appear between Markdown paragraphs. Do not wrap the whole response in a code block.

`state` is a map of named initial values. A value can be a string, finite number, Boolean, null, or an array of those values. Declare each key before referencing it. Use `{"state":"key"}` wherever a value is bindable. Use `"when":{"state":"key","equals":"value"}` on a node to show it conditionally. State changes stay within the widget. Choose one concise layout, avoid redundant copies of the message, and label controls with what they do.

## Component catalog

| type | Fields and behavior |
| --- | --- |
| `card`, `row`, `column`, `grid` | `children` array; optional `title` |
| `details` | `title`, `children`; user can expand/collapse |
| `tabs` | `items:[{"label":"…","children":[…]}]`; two or more views |
| `heading`, `text`, `badge` | `value` as literal or state reference |
| `link` | `label`, `url` as http or https; opens only when clicked |
| `divider` | No additional fields |
| `code` | `value` as plain code text, optional `language`; copy control |
| `input` | `label`, `kind`, `state` key; types listed below |
| `metric` | `label`, `operation`, `values` of numbers/state references, optional `unit` |
| `table` | `columns` array of labels, `rows` array of scalar arrays. Match row length to columns. Column headers sort. Optional `search:true`, `filter:{"state":"key","column":0}` based on a zero-indexed column. A null, empty string or empty array selects all rows. |
| `chart` | `kind:"bar"` or `"line"`, `label`, `labels` string array, `series:[{"label":"…","values":[1,2]}]`. Supply one value per label. Users can toggle chart series or inspect the data table. |
| `button` | `label`, `action` object; actions listed below |

Input kinds `text` and `date` use a string initial value (for dates, use ISO YYYY-MM-DD or empty). `toggle` uses a Boolean. `number` and `range` use a number and accept `min`, `max`, `step`; `range` requires `min` and `max`. `select` and `radio` need `options:[{"label":"…","value":"…"}]` and a matching string initial value. `multi` uses the same options and an array of matching choice values.

Metric operations `sum` and `product` take two to eight values. `difference` computes the first minus the second, `ratio` divides first by second, and `percent` multiplies that ratio by 100. Use two values for those three. Handle unavailable results in explanation if a divisor can be zero.

## Button actions

- `{"type":"copy","value":"some text"}` copies a literal or state reference on click.
- `{"type":"set","state":"key","value":"chosen value"}` sets a matching state value.
- `{"type":"reset"}` restores the declared initial state.
- `{"type":"draft","value":"다음 요청"}` appends text to the chat composer. The user reviews and sends it.
- `draft` also accepts `fields:[{"label":"값","state":"key"}]` alone or after `value` to add edited values. Make the button label clear that it adds to the input.
- `{"type":"download","filename":"result.txt","value":"content"}` downloads supplied text. Supported extensions are txt, csv, json and md. Use a literal or state reference.

All local actions require explicit user interaction. The schema describes display and available actions as data. Write code or commands as visible text where appropriate. A widget can draft a follow-up request, and ordinary chat handles any later tool work.

## Example

A compact adjustable comparison in the user's language:

```tabroom-ui
{
  "version": 1,
  "state": {"group":"","quantity":2},
  "nodes": [
    {"type":"card","title":"조건 바꿔보기","children":[
      {"type":"input","kind":"select","label":"분류","state":"group","options":[{"label":"전체","value":""},{"label":"A","value":"A"},{"label":"B","value":"B"}]},
      {"type":"table","columns":["분류","값"],"rows":[["A",4],["B",8]],"filter":{"state":"group","column":0}},
      {"type":"input","kind":"range","label":"수량","state":"quantity","min":1,"max":10,"step":1},
      {"type":"metric","label":"합계","operation":"product","values":[4,{"state":"quantity"}]},
      {"type":"button","label":"선택 내용을 입력창에 넣기","action":{"type":"draft","value":"이 조건으로 다시 계산해줘.","fields":[{"label":"분류","state":"group"},{"label":"수량","state":"quantity"}]}}
    ]}
  ]
}
```

Limits are four widgets in a message, 32,000 characters per block, 120 nodes per widget, 32 state keys, 80 table rows, 12 columns. State keys start with a letter and use letters, combining marks, digits, underscores or hyphens. Localized keys such as `수량` are supported. Keep payloads small. Use factual values you have, and use null for unknown cells. State values are stored for the current page session where the host supplies a message key.
