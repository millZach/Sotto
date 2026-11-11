#import <Foundation/Foundation.h>
#import <objc/message.h>
#include <dlfcn.h>
typedef struct { long long a; double b; long long c; long long d; BOOL e; long long f; double g; double h; } Swap;
int main(int argc, char **argv) { @autoreleasepool {
  dlopen("/System/Library/PrivateFrameworks/SpringBoardFoundation.framework/SpringBoardFoundation", RTLD_NOW);
  dlopen("/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices", RTLD_NOW);
  NSMutableArray *args = [NSMutableArray array];
  for (int i = 1; i < argc; i++) [args addObject:@(argv[i])];
  Swap (*from)(NSArray *, NSError **) = dlsym(RTLD_DEFAULT, "SBFDisplayToolSwapSettingsFromArguments");
  NSError *err = nil;
  Swap r = from(args, &err);
  long long *w = (long long *)&r;
  Swap s; memset(&s, 0, sizeof s);
  s.a = 0; memcpy(&s.b, &w[0], 8); s.c = w[1]; s.d = w[2]; s.e = (BOOL)w[3]; s.f = w[4]; memcpy(&s.g, &w[5], 8);
  if (getenv("KIND")) s.a = atoll(getenv("KIND"));
  printf("err=%s\nkind=%lld dur=%f orient=%lld profile=%lld wait=%d mode=%lld pos=%f %f\n", err ? err.description.UTF8String : "nil", s.a, s.b, s.c, s.d, s.e, s.f, s.g, s.h);
  if (err || getenv("DRY")) return 0;
  id service = [[NSClassFromString(@"SBSDisplayToolService") alloc] init];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  ((void (*)(id, SEL, Swap, void (^)(id)))objc_msgSend)(service, NSSelectorFromString(@"swapDisplayWithSettings:completionHandler:"), s, ^(id e) {
    printf("swap done: %s\n", e ? [[e description] UTF8String] : "ok"); dispatch_semaphore_signal(done); });
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)); [service performSelector:NSSelectorFromString(@"invalidate")];
}}
