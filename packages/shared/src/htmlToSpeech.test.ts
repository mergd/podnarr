import { describe, expect, test } from "bun:test";

import { htmlToNarrationScript, htmlToPlainText } from "./htmlToSpeech";

const quoteHtml = `
<p><strong>Pritchard argues that the effect of income on happiness, though real, is small:</strong></p>
<blockquote>
  <p>In short, a correlation does exist, and it&#8217;s plausibly causal. But it&#8217;s pretty small.</p>
  <p>How small? Well, Alexander cites another article.</p>
</blockquote>
<p>Pritchard states that the effect of her income change is the same as requiring a person to be a full-time caregiver.</p>
`;

const listHtml = `
<p>Here are some other differences about as big as a 4x income difference:</p>
<ul>
  <li><p>The difference between married people and divorced people.</p></li>
  <li><p>3x the difference between normal-weight people and obese people</p></li>
  <li><p>The point-in-time difference between it being a weekend vs. a weekday.</p></li>
</ul>
<p>This is merely a 4x income difference.</p>
`;

describe("htmlToNarrationScript", () => {
  test("marks blockquotes as quoted paragraphs with pauses", () => {
    const script = htmlToNarrationScript(quoteHtml);
    expect(script).toContain("[quoting] \"In short, a correlation does exist, and it’s plausibly causal. But it’s pretty small.\" [pause]");
    expect(script).toContain("[quoting] \"How small? Well, Alexander cites another article.\" [pause]");
    expect(script).toContain("Pritchard argues that the effect of income on happiness, though real, is small: [pause]");
    expect(script).toContain("Pritchard states that the effect of her income change is the same as requiring a person to be a full-time caregiver. [pause]");
    expect(script?.indexOf("[quoting] \"In short")).toBeGreaterThan(script?.indexOf("Pritchard argues") ?? -1);
    expect(script?.indexOf("Pritchard states")).toBeGreaterThan(script?.indexOf("[quoting] \"How small") ?? -1);
  });

  test("turns list items into their own paused paragraphs", () => {
    const script = htmlToNarrationScript(listHtml);
    const paragraphs = script?.split(/\n{2,}/) ?? [];
    expect(paragraphs[0]).toBe("Here are some other differences about as big as a 4x income difference: [pause]");
    expect(paragraphs[1]).toBe("The difference between married people and divorced people. [pause]");
    expect(paragraphs[2]).toBe("3x the difference between normal-weight people and obese people [pause]");
    expect(paragraphs[3]).toBe("The point-in-time difference between it being a weekend vs. a weekday. [pause]");
    expect(paragraphs[4]).toBe("This is merely a 4x income difference. [pause]");
  });

  test("keeps image markers for later description", () => {
    const script = htmlToNarrationScript('<p>Before</p><img src="https://example.com/chart.png" alt="chart"><p>After</p>');
    expect(script).toContain("[[podnarr-visual src=\"https://example.com/chart.png\"]] [pause]");
    expect(script).toContain("Before [pause]");
    expect(script).toContain("After [pause]");
  });
});

describe("htmlToPlainText", () => {
  test("wraps quotes and separates list items without speech tags", () => {
    const text = htmlToPlainText(`${quoteHtml}${listHtml}`);
    expect(text).toContain("\"In short, a correlation does exist, and it’s plausibly causal. But it’s pretty small.\"");
    expect(text).not.toContain("[quoting]");
    expect(text).not.toContain("[pause]");
    expect(text).toContain("The difference between married people and divorced people.");
    expect(text?.split(/\n{2,}/).length).toBeGreaterThan(6);
  });
});
