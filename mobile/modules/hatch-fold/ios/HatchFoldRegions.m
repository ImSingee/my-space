#import "HatchFoldRegions.h"

NSArray<NSValue *> *HatchFoldDivisionFrames(UIView *view) {
// Reserved regions arrived in the iOS 27.1 SDK; older SDKs build without them.
#if defined(__IPHONE_27_1) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_27_1
  if (@available(iOS 27.1, *)) {
    NSMutableArray<NSValue *> *frames = [NSMutableArray array];
    // Inactive regions too: a fully open display folds at the same place, and
    // keeping the layout there avoids a jump when the device is half folded.
    NSArray<UIViewReservedRegion *> *regions =
        [view reservedRegionsOfKind:[UIViewReservedRegionKind divisionRegionKind]
                            options:UIViewReservedRegionQueryOptionsIncludeInactive];
    for (UIViewReservedRegion *region in regions) {
      [frames addObject:[NSValue valueWithCGRect:region.frame]];
    }
    return frames;
  }
#endif
  return @[];
}
