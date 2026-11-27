#import "../overlay/native/arrow-cursor.h"
#include <cassert>
#include <cstdio>

int main() {
    @autoreleasepool {
        [NSApplication sharedApplication];
        assert(!ArrowCursorInstalled());
        assert(InstallArrowCursor());
        assert(InstallArrowCursor()); // Reconfiguration must not hook itself.
        NSArray<NSCursor *> *cursors = @[
            NSCursor.IBeamCursor, NSCursor.resizeLeftRightCursor,
            NSCursor.resizeUpDownCursor, NSCursor.pointingHandCursor,
            NSCursor.crosshairCursor, NSCursor.openHandCursor,
            NSCursor.closedHandCursor, NSCursor.operationNotAllowedCursor,
            [[NSCursor alloc] initWithImage:NSCursor.IBeamCursor.image hotSpot:NSZeroPoint]
        ];
        for (NSCursor *cursor in cursors) {
            [cursor set];
            assert([NSCursor.currentCursor isEqual:NSCursor.arrowCursor]);
            [cursor push];
            assert([NSCursor.currentCursor isEqual:NSCursor.arrowCursor]);
            [NSCursor.crosshairCursor push];
            assert([NSCursor.currentCursor isEqual:NSCursor.arrowCursor]);
            [NSCursor pop];
            assert([NSCursor.currentCursor isEqual:NSCursor.arrowCursor]);
            [NSCursor pop];
            assert([NSCursor.currentCursor isEqual:NSCursor.arrowCursor]);
        }
        puts("PASS native text, resize, hand and custom cursors remain arrows; nested cursor stacks stay balanced");
    }
    return 0;
}
