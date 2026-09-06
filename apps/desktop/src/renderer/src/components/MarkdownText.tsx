import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-text">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href = "", children, ...props }) => <a {...props} href={href} target={/^https?:\/\//i.test(href) ? "_blank" : undefined} rel={/^https?:\/\//i.test(href) ? "noreferrer" : undefined}>{children}</a>,
      }}
    >{text}</ReactMarkdown>
  </div>;
}
