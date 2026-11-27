#pragma once
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// CSS covers Chromium content, but AppKit owns the native window resize cursor.
// Replace only cursor operations inside this process. No event taps, timers,
// window subclass replacement, or changes to another application's cursors.
namespace {
using CursorOperation = void (*)(id, SEL);
CursorOperation originalCursorSet = nullptr;
CursorOperation originalCursorPush = nullptr;

void SetArrowCursor(id, SEL selector) {
    originalCursorSet(NSCursor.arrowCursor, selector);
}
void PushArrowCursor(id, SEL selector) {
    // Keep AppKit's stack balanced; the item pushed must also be the arrow.
    originalCursorPush(NSCursor.arrowCursor, selector);
}
bool ArrowCursorInstalled() {
    return originalCursorSet && originalCursorPush;
}
bool InstallArrowCursor() {
    if (![NSThread isMainThread]) return false;
    if (ArrowCursorInstalled()) return true;
    Method set = class_getInstanceMethod(NSCursor.class, @selector(set));
    Method push = class_getInstanceMethod(NSCursor.class, @selector(push));
    if (!set || !push) return false;
    originalCursorSet = reinterpret_cast<CursorOperation>(method_setImplementation(set, reinterpret_cast<IMP>(SetArrowCursor)));
    originalCursorPush = reinterpret_cast<CursorOperation>(method_setImplementation(push, reinterpret_cast<IMP>(PushArrowCursor)));
    return ArrowCursorInstalled();
}
}
