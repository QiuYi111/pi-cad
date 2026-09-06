import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "../src/renderer/src/components/MarkdownText";

describe("assistant Markdown", () => {
  it("renders headings, emphasis, lists, rules, code, and tables", () => {
    const html = renderToStaticMarkup(<MarkdownText text={"## Q1\n\n**重点**\n\n- A\n- B\n\n---\n\n`x`\n\n| 项 | 值 |\n|---|---|\n| 宽 | 80 |"} />);
    expect(html).toContain("<h2>Q1</h2>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<li>A</li>");
    expect(html).toContain("<hr/>");
    expect(html).toContain("<code>x</code>");
    expect(html).toContain("<table>");
  });

  it("does not execute inline HTML", () => {
    const html = renderToStaticMarkup(<MarkdownText text={'<img src=x onerror="alert(1)">'} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
  });
});
