// Tao currently handles applicationWillTerminate, but does not offer a veto
// for Dock Quit. Route Cocoa termination through the same Tauri menu event as
// Command-Q so Rust can asynchronously cancel tasks before calling app.exit().
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

static NSApplicationTerminateReply latte_should_terminate(id self, SEL selector, NSApplication *app) {
    (void)self;
    (void)selector;
    dispatch_async(dispatch_get_main_queue(), ^{
        for (NSMenuItem *top in app.mainMenu.itemArray) {
            NSMenu *menu = top.submenu;
            for (NSInteger index = 0; index < menu.numberOfItems; index++) {
                if ([[menu itemAtIndex:index].title isEqualToString:@"退出 Latte Work"]) {
                    [menu performActionForItemAtIndex:index];
                    return;
                }
            }
        }
        NSLog(@"Latte Work: graceful quit menu is unavailable; refusing unverified termination");
    });
    return NSTerminateCancel;
}

@interface LatteQuitRouting : NSObject
@end
@implementation LatteQuitRouting
+ (void)load {
    @autoreleasepool {
        [NSNotificationCenter.defaultCenter
            addObserverForName:NSApplicationDidFinishLaunchingNotification
            object:nil queue:nil usingBlock:^(NSNotification *notification) {
                NSApplication *app = notification.object;
                Class delegateClass = object_getClass(app.delegate);
                // Add only the missing delegate method; never replace Tao callbacks.
                if (!class_addMethod(delegateClass, @selector(applicationShouldTerminate:),
                                     (IMP)latte_should_terminate, "Q@:@")) {
                    NSLog(@"Latte Work: could not install graceful quit routing");
                }
            }];
    }
}
@end
