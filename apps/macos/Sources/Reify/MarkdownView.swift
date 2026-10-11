import SwiftUI
import AppKit

struct MarkdownNode: Decodable {
    let type: String
    let value: String?
    let alt: String?
    let children: [MarkdownNode]?
    let url: String?
    let lang: String?
    let depth: Int?
    let ordered: Bool?
    let start: Int?
    let checked: Bool?
    let align: [String?]?
    var nodes: [MarkdownNode] { children ?? [] }
}

struct MarkdownView: View {
    @EnvironmentObject var app: AppModel
    let text: String
    @State private var document: MarkdownNode?
    var body: some View {
        Group {
            if let document { block(document) }
            else { Text(text).textSelection(.enabled) }
        }.font(ReifyDesign.font(14)).lineSpacing(5)
            .task(id: text) { document = try? app.presentation.markdown(text) }
            .environment(\.openURL, OpenURLAction { url in
                if ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { return .systemAction }
                if url.scheme == nil { Task { await app.openToolArtifact(url.relativeString) }; return .handled }
                return .discarded
            })
    }
    private func inline(_ node: MarkdownNode) -> Text {
        let children = node.nodes.reduce(Text("")) { $0 + inline($1) }
        switch node.type {
        case "text": return Text(node.value ?? "")
        case "strong": return children.bold()
        case "emphasis": return children.italic()
        case "delete": return children.strikethrough()
        case "inlineCode": return Text(node.value ?? "").font(.system(size: 13, design: .monospaced)).foregroundColor(ReifyDesign.green)
        case "break": return Text("\n")
        case "link":
            var value = AttributedString(node.nodes.map(plain).joined())
            if let url = node.url.flatMap(URL.init(string:)), url.scheme == nil || ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { value.link = url }
            return Text(value)
        case "image": return Text(node.alt ?? "图片")
        case "html": return Text("")
        default: return children
        }
    }
    private func plain(_ node: MarkdownNode) -> String { node.value ?? node.alt ?? node.nodes.map(plain).joined() }
    private func block(_ node: MarkdownNode) -> AnyView {
        switch node.type {
        case "root", "listItem":
            return AnyView(VStack(alignment: .leading, spacing: 12) { ForEach(Array(node.nodes.enumerated()), id: \.offset) { _, child in block(child) } }.frame(maxWidth: .infinity, alignment: .leading))
        case "paragraph": return AnyView(inline(node).textSelection(.enabled).fixedSize(horizontal: false, vertical: true))
        case "heading": return AnyView(inline(node).font(ReifyDesign.font(max(14, 25 - Double(node.depth ?? 1) * 2), .semibold)).textSelection(.enabled))
        case "code":
            return AnyView(VStack(alignment: .leading, spacing: 8) {
                HStack { Text(node.lang ?? "代码").foregroundStyle(ReifyDesign.muted); Spacer(); Button("复制") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(node.value ?? "", forType: .string) }.buttonStyle(.plain) }.font(ReifyDesign.font(10))
                ScrollView(.horizontal) { Text(node.value ?? "").font(.system(size: 12, design: .monospaced)).textSelection(.enabled).fixedSize() }
            }.padding(12).background(ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 8)))
        case "list":
            return AnyView(VStack(alignment: .leading, spacing: 8) { ForEach(Array(node.nodes.enumerated()), id: \.offset) { index, child in
                HStack(alignment: .top, spacing: 8) {
                    if let checked = child.checked { Image(systemName: checked ? "checkmark.square" : "square").padding(.top, 3) }
                    else { Text(node.ordered == true ? "\((node.start ?? 1) + index)." : "•").frame(minWidth: 16, alignment: .trailing) }
                    block(child)
                }
            } })
        case "blockquote": return AnyView(HStack(alignment: .top, spacing: 12) { Rectangle().fill(ReifyDesign.muted.opacity(0.4)).frame(width: 3); VStack(alignment: .leading, spacing: 8) { ForEach(Array(node.nodes.enumerated()), id: \.offset) { _, child in block(child) } } }.fixedSize(horizontal: false, vertical: true).foregroundStyle(ReifyDesign.muted))
        case "table":
            return AnyView(ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) { ForEach(Array(node.nodes.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow { ForEach(Array(row.nodes.enumerated()), id: \.offset) { column, cell in
                        inline(cell).font(ReifyDesign.font(12, rowIndex == 0 ? .semibold : .regular)).textSelection(.enabled)
                            .frame(minWidth: 110, alignment: column < (node.align?.count ?? 0) && node.align?[column] == "right" ? .trailing : column < (node.align?.count ?? 0) && node.align?[column] == "center" ? .center : .leading)
                            .padding(10).background(rowIndex == 0 ? ReifyDesign.panel : .clear).overlay(alignment: .bottom) { Divider() }
                    } }
                } }
            })
        case "thematicBreak": return AnyView(Divider())
        case "html": return AnyView(EmptyView())
        default: return AnyView(inline(node).textSelection(.enabled))
        }
    }
}
