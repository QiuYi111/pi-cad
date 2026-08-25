---
name: imagegen
description: Generate or edit a raster image with codex_generate_image through the ChatGPT-backed Codex Images flow used by Codex CLI. Use whenever a raster image materially helps the task, including visual concept exploration.
---

# Codex image generation and editing

Use `codex_generate_image` when creating or editing a raster image materially
helps the task, including workflow-directed visual concept exploration. It follows the same
authenticated Codex Images service path as the built-in Codex CLI experience.
Do not imply that this package has its own allowance or usage limit. If asked
about availability or limits, explain that they follow the provider-managed
Codex service and may change.

- Write a concise, concrete prompt describing purpose, subject, composition,
  style, lighting, colors, and hard constraints.
- For edits, repeat invariants explicitly: identify what may change and what
  must remain unchanged.
- Pass `referencedImagePaths` only for one to five local PNG, JPEG, or WebP files
  the user explicitly wants uploaded to Codex. Preserve their intended order
  and describe each image's role in the prompt.
- Local reference uploads require interactive approval. If the user only
  attached an image without a usable local path, explain that direct
  conversation-image selection is not supported yet and ask for its path.
- Pass `outputPath` only when the user asks for a specific destination.
- Otherwise leave `save` as `auto`: Prime saves under the current project's
  `.pi/generated-images/` directory.
- Use `save: "none"` only when the user asks to preview without saving.
- Do not invoke this tool for image analysis or SVG/code-native graphics, and
  avoid redundant generations that do not materially improve the result.
- The current version creates one PNG. It does not support masks, batch
  generation, native transparency controls, or JPEG/WebP output.
