import ExpoModulesCore
import UIKit

/// A view that reports where its window's display folds across it. Mounted
/// behind a container, its coordinates are the container's.
final class HatchFoldView: ExpoView {
  let onFoldChange = EventDispatcher()
  private var reported: [[String: Double]]?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    backgroundColor = .clear
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    report()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Folding or unfolding moves the app to another display's window.
    report()
  }

  private func report() {
    guard window != nil else { return }
    let folds = HatchFoldDivisionFrames(self).map { value -> [String: Double] in
      let frame = value.cgRectValue
      return [
        "x": Double(frame.origin.x),
        "y": Double(frame.origin.y),
        "width": Double(frame.size.width),
        "height": Double(frame.size.height),
      ]
    }
    if folds == reported { return }
    reported = folds
    onFoldChange(["folds": folds])
  }
}

public final class HatchFoldModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HatchFold")
    View(HatchFoldView.self) {
      Events("onFoldChange")
    }
  }
}
