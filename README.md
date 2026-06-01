<h1 align="center"><b>Magic Copy</b></h1>

<p align="center"><i>Copy any HTML element with all its computed CSS styles inlined — straight from the page or DevTools.</i></p>

<p align="center">Built with the tools and technologies:</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/Plasmo-3F51B5?style=for-the-badge&logo=plasmo&logoColor=white" alt="Plasmo" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/Monaco_Editor-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Monaco Editor" />
  <img src="https://img.shields.io/badge/Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome" />
</p>

<p align="center">
  <img width="1874" height="967" alt="Magic Copy DevTools sidebar with live preview and Monaco source" src="https://github.com/user-attachments/assets/a6fa28a6-e62d-4cc3-8d20-44902d9fd2d3" />
  <br/>
  <em>DevTools sidebar — live preview, Monaco source view, and CSS→Tailwind conversion</em>
</p>

<p align="center">
  <img width="892" height="967" alt="Magic Copy inlined element output" src="https://github.com/user-attachments/assets/7d59979c-0048-4f56-a1eb-6e7a6ef95cd1" />
  <br/>
  <em>Captured element with computed styles inlined</em>
</p>

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Usage](#usage)
- [Loading the Extension in Chrome](#loading-the-extension-in-chrome)
- [Using Magic Copy](#using-magic-copy)
- [Project Structure](#project-structure)

---

## Overview

Magic Copy is a Chrome extension that copies any HTML element with all of its **computed** CSS styles inlined — so what you paste looks exactly like what you saw on the page, with no missing stylesheet to chase down. Capture an element from the page's right-click menu or from a dedicated DevTools Elements sidebar, preview it live, tweak the source in a Monaco editor, and optionally convert the inline CSS to Tailwind classes before copying.

### Why Magic Copy?

- 🖱️ **Right-click to copy** — "Copy element with inline CSS" appears in the page context menu on any site
- 🧩 **DevTools sidebar** — A "Magic Copy (inline CSS)" pane in the Elements panel for precise, inspector-driven capture
- 🎯 **Full computed styles** — Walks the element via `getComputedStyle` so every applied rule is inlined, not just author styles
- ✨ **Pseudo-elements** — Captures `::before`, `::after`, and friends so decorative styling survives the copy
- 🪄 **Pseudo-state capture** — Uses the Chrome DevTools Protocol to force `:hover`, `:focus`, and other states for accurate previews
- 👀 **Live preview** — Renders the captured markup with page background and dark-mode detection so it matches the source page
- 📝 **Monaco source view** — Inspect and edit the generated HTML/CSS with syntax highlighting and beautification
- 🌬️ **CSS → Tailwind** — Convert the inlined CSS to Tailwind utility classes with one toggle

---

## How It Works

1. **Select** — Pick an element via the page right-click menu or the DevTools Elements sidebar.
2. **Extract** — Magic Copy reads every computed style on the element (and its pseudo-elements), optionally forcing pseudo-states like `:hover` through the Chrome DevTools Protocol.
3. **Preview** — The captured markup renders in a live preview pane that mirrors the page's background and theme.
4. **Refine** — Inspect and edit the output in the Monaco source view, and optionally convert the inline CSS to Tailwind classes.
5. **Copy** — Grab the result and paste it anywhere — it carries its full styling with it.

---

## Getting Started

### Prerequisites

This project requires the following:

| | Requirement | Version |
|---|---|---|
| **Programming Language** | TypeScript | ^5.6 |
| **Runtime** | Node.js | 18+ |
| **Framework** | Plasmo | ^0.90 |
| **UI** | React | ^18.3 |

### Installation

**Clone the repository:**

```bash
git clone https://github.com/Niggo2k/magic-copy.git
```

**Navigate to the project directory:**

```bash
cd magic-copy
```

**Install the dependencies:**

```bash
npm install
```

### Usage

**Start the development server** (watch mode with hot reload):

```bash
npm run dev
```

**Create a production build:**

```bash
npm run build
```

**Package the extension for distribution:**

```bash
npm run package
```

---

## Loading the Extension in Chrome

1. Run `npm run dev` (output: `build/chrome-mv3-dev`) or `npm run build` (output: `build/chrome-mv3-prod`).
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the generated build folder (e.g. `build/chrome-mv3-prod`).

While running `npm run dev`, Plasmo rebuilds on save — reload the extension from `chrome://extensions` to pick up changes.

---

## Using Magic Copy

**From the page:** Right-click any element and choose **Copy element with inline CSS**.

**From DevTools:** Open DevTools → **Elements** panel → select the **Magic Copy (inline CSS)** sidebar pane. Use the live preview, Monaco source view, and the CSS → Tailwind toggle, then copy the result.

---

## Project Structure

| Path | Purpose |
|------|---------|
| `background.ts` | Service worker — registers the context menu and routes messages |
| `devtools.tsx` | DevTools entry point — creates the Elements sidebar pane |
| `tabs/sidebar.tsx` | Main UI — preview, Monaco editor, and conversion controls |
| `contents/copy-on-rightclick.ts` | Content script — handles right-click capture on the page |
| `components/MonacoSource.tsx` | Monaco editor wrapper (syntax highlighting + beautification) |
| `lib/inline-styles.ts` | Core logic — extracts computed styles and pseudo-elements |
| `lib/cdp.ts` | Chrome DevTools Protocol integration for pseudo-state capture |
| `lib/css-to-tailwind.ts` | CSS → Tailwind conversion wrapper |
| `lib/state-snapshot.ts` | State management for preview data |

---

[Return to top](#magic-copy)
