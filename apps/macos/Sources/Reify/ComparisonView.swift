import SwiftUI
import ReifyCloud

struct ComparisonView: View {
    @EnvironmentObject var app: AppModel
    let primary: EngineeringArtifact
    let primaryData: Data
    let secondary: EngineeringArtifact
    let secondaryData: Data
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("版本比较").font(ReifyDesign.font(13, .medium))
                Spacer()
                Button("复位两个视图") { app.comparisonReset += 1 }.accessibilityIdentifier("comparison.reset")
                Button("结束比较") { app.closeComparison() }.accessibilityIdentifier("comparison.close")
            }.padding(12).buttonStyle(ReifyButtonStyle()).background(ReifyDesign.paper)
            HStack(spacing: 0) {
                model(primary, data: primaryData, id: "primary")
                Divider()
                model(secondary, data: secondaryData, id: "secondary")
            }
        }.accessibilityIdentifier("comparison.view")
    }
    private func model(_ artifact: EngineeringArtifact, data: Data, id: String) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text((artifact.path as NSString).lastPathComponent).lineLimit(1)
                Text("SHA-256 \(artifact.sha256.prefix(12))").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted).textSelection(.enabled)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(ReifyDesign.paper)
            ModelPreview(data: data, artifactOverride: artifact, compact: true, resetEpoch: app.comparisonReset)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("comparison.\(id)")
    }
}
