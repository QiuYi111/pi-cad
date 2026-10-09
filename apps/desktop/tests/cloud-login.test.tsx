import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudLogin } from "../src/renderer/src/pages/CloudLogin";
import { CloudManualCode } from "../src/renderer/src/components/CloudManualCode";

describe("cloud sign-in page", () => {
  it("offers email and password with the server address behind the advanced toggle", () => {
    const html = renderToStaticMarkup(<CloudLogin baseUrl="https://example.test" onSignedIn={() => undefined} />);
    expect(html).toContain("邮箱");
    expect(html).toContain("密码");
    expect(html).toContain("高级设置");
    expect(html).not.toContain("服务器地址");
    expect(html).toContain("忘记密码？");
  });

  it("renders the form without the page frame in compact mode", () => {
    const html = renderToStaticMarkup(<CloudLogin baseUrl="" onSignedIn={() => undefined} compact />);
    expect(html).toContain('class="cloud-login compact"');
    expect(html).not.toContain("登录 Reify 云端");
  });
});

describe("cloud manual code", () => {
  it("shows the OAuth paste instruction next to the callback box", () => {
    const html = renderToStaticMarkup(<CloudManualCode value="" onChange={() => undefined} onSubmit={() => undefined} />);
    expect(html).toContain("浏览器显示无法连接时，复制地址栏的完整地址，粘贴到这里");
    expect(html).toContain("disabled");
  });
});
