# Folded iPhone Duo rail with a Live Activity

The timer in the device report pushed the clock, battery and cellular signal over New thread. On a folded iPhone Duo simulator running iOS 27.2, a separate fixture started a Live Activity through ActivityKit. Sotto ran its Threads fixture with Wi-Fi active, one bar of cellular signal and 26% battery. Both builds used Xcode 27.2 and the same simulator with the activity still running.

At 176 points, iOS covered the top of the button and the horizontal stroke of the plus. At 216 points, the entire button is visible. The last row of signal dots was at pixel 593 and the button ring started at pixel 648, leaving 18 points at 3× scale. The bottom 830 pixels of the tab strip matched between captures. [Before](../../artifacts/iphone-duo-thread-rail/folded-activity-before.jpg) · [After](../../artifacts/iphone-duo-thread-rail/folded-activity-new-thread.jpg)

New owlet on the five-tab rail and Back in an open thread also cleared the indicators. [New owlet](../../artifacts/iphone-duo-thread-rail/folded-activity-new-owlet.jpg) · [Back](../../artifacts/iphone-duo-thread-rail/folded-activity-back.jpg)

The scene reported the same 84-point trailing safe-area inset and 2-point status-bar frame height before and after the activity started. Neither measurement tracked how far the indicators moved down the strip.
