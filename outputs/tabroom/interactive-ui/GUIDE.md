# Tabroom Interactive UI · v1

Read the [interactive UI skill](../../tabroom-launcher/skills/tabroom-interactive-ui/SKILL.md) for the message format, component catalog, and a complete working example.

## Embedding in another agent


Provide the interactive UI skill as trusted instructions when an agent needs to produce a widget. It only needs to produce normal assistant text. The UI host imports `renderAssistantContent(container,text,options)` from `render.js`. Call it for completed assistant messages with a stable, unique `messageKey`. Supply a local `onDraft(text)` callback that returns true on successful insertion. Pass `streaming:true` for a draft. Include `styles.css`. The parser and validator live in `protocol.js` and can also be used independently.
