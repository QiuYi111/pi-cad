// Use the same Markdown grammar as desktop; SwiftUI renders the parsed tree.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
const parser = unified().use(remarkParse).use(remarkGfm);
globalThis.reifyMarkdown = text => JSON.stringify(parser.parse(text));
