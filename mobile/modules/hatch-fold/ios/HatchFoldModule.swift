import ExpoModulesCore
import QuartzCore
import UIKit

/// A view that reports where its window's display folds across it. Mounted
/// behind a container, its coordinates are the container's.
///
/// UIKit has no notification for reserved regions, and they are in this
/// view's coordinates: they also move when an ancestor moves the view without
/// resizing it, as a vertical bar or safe area changes sides. So after the
/// scene's geometry changes (fold, unfold, rotation), the view moves to a
/// window or resizes, it reads them again for a short while, until layout has
/// settled, and reports only changes.
final class HatchFoldView: ExpoView {
  let onFoldChange = EventDispatcher()
  private var reported: [[String: Double]]?
  private var geometry: NSKeyValueObservation?
  private var timer: Timer?
  private var watchUntil: CFTimeInterval = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    backgroundColor = .clear
  }

  deinit {
    timer?.invalidate()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    report()
    watch(for: 0.5)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Folding or unfolding moves the app to another display's window.
    geometry = window?.windowScene?.observe(\.effectiveGeometry) {
      [weak self] _, _ in
      DispatchQueue.main.async { self?.watch(for: 1.5) }
    }
    guard window != nil else {
      timer?.invalidate()
      timer = nil
      return
    }
    report()
    watch(for: 1.5)
  }

  private func watch(for seconds: CFTimeInterval) {
    guard window != nil else { return }
    watchUntil = max(watchUntil, CACurrentMediaTime() + seconds)
    guard timer == nil else { return }
    let timer = Timer(timeInterval: 1.0 / 30, repeats: true) {
      [weak self] timer in
      guard let self, self.window != nil,
        CACurrentMediaTime() < self.watchUntil
      else {
        timer.invalidate()
        self?.timer = nil
        return
      }
      self.report()
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
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
    // Only where a fold crosses matters; scrolling moves it along its length.
    if let reported, reported.count == folds.count,
      zip(reported, folds).allSatisfy({ old, new in
        old["x"] == new["x"] && old["width"] == new["width"]
          && old["height"] == new["height"]
      })
    {
      return
    }
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
