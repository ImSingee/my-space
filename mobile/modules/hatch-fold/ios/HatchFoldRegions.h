#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// The division reserved regions of `view` (where a foldable display folds),
/// active or not, as frames in the view's own coordinates. Empty when the SDK
/// or the system has no reserved regions, which means there is no fold.
FOUNDATION_EXPORT NSArray<NSValue *> *HatchFoldDivisionFrames(UIView *view);

NS_ASSUME_NONNULL_END
