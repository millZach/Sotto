# iPhone UI good practice: a rubric for reviewing Sotto's iPhone app

Studied on 2026-10-29 in worktree `a37efd14-5d21-48da-ac85-961fe038811a`, on branch `sotto/ios-ui-hillclimb-review` at `e1f838016`. Research only: nothing was built, run, edited or committed, and no screenshot was looked at.

This is the iPhone half of the UI hillclimb. It is a rubric to score screenshots and SwiftUI code against: each rule names its source, with numbers where the source gives them. The general principles (hierarchy, spacing, colour, feedback, motion, simplicity, the severity ranking) are in the desktop rubric, [`ui-good-practice.md`](ui-good-practice.md) (during the hillclimb, `~/ui-hillclimb/research-desktop.md`). This note cites it by section and keeps what is specific to iOS and to this app. Section 5 is the checklist of vibe-coded tells, with a grep for each.

## Basis and limits

- **Read as raw text, so quotes are verbatim.**
  - Apple HIG, 45 pages, from Apple's own JSON (`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`), because the HTML pages render in the browser and return only a title. These are the pages as of 2026-10-29; their change logs show edits in June, September and October 2026.
  - WWDC transcripts from `developer.apple.com/videos/play/...`: Essential Design Principles (WWDC17), Designing Fluid Interfaces (WWDC18), Designing Audio-Haptic Experiences (WWDC19), Make your app visually accessible and Design with iOS pickers, menus and actions (WWDC20), Explore navigation design for iOS and Writing for interfaces (WWDC22), Animate with springs (WWDC23), Get started with Dynamic Type (WWDC24), Meet Liquid Glass, Get to know the new design system and Build a SwiftUI app with the new design (WWDC25). A timestamp here is the start of the transcript passage the claim is in, good to about 30 seconds.
  - SwiftUI and UIKit reference pages, from the same JSON route, with their availability.
  - WCAG 2.2 (W3C Recommendation, 12 December 2024) and WCAG2ICT (W3C Group Note, 11 December 2025).
  - Nielsen Norman Group, LukeW, Bjango and Lux (Halide), fetched with `curl` and stripped to text.
- **Not covered.** No WWDC26 session was read, so anything iOS 27 changed is known only where a current HIG page says it. HIG has no separate Navigation bars, Liquid Glass or Refresh content controls page any more (404); that guidance now sits in Toolbars, Materials and Progress indicators. The WWDC17 "Building Apps with Dynamic Type" page has no transcript. Bjango has no article on iOS corner radii. The Lux essay is pre-WWDC25 speculation and is used once, for history.
- **Units.** Apple gives points. WCAG gives CSS pixels; WCAG2ICT says to use "points (pt) for iOS and macOS" in their place ([WCAG2ICT, Applying "CSS pixel"](https://www.w3.org/TR/wcag2ict-22/)).
- **Unverified** marks anything stated without a fetched source.
- **Counts** of code patterns are from `grep -rnE '<pattern>' apps/ios/Sotto --include=*.swift` on `e1f838016`. They are leads, not findings: many hits are fine.

## The platform this app is on

| Fact | Where |
|---|---|
| Deployment target iOS 17.0 | `apps/ios/Sotto.xcodeproj/project.pbxproj` |
| CI's UI journeys and screenshots are built with Xcode 26.6 | `.github/workflows/ci.yml:480` |
| TestFlight builds, what Zach's and Drake's phones run, use Xcode 27.1 | `.github/workflows/ios-testflight.yml:27`, ADR-0151 October 28 amendment |
| So CI captures show the iOS 26 SDK's system chrome and the phones show iOS 27's. Compare like with like. | |
| Figtree in three static weights, regular, semibold and bold, because iOS does not synthesize weights for a custom font | `apps/ios/README.md` › Bundled assets |
| Six palettes generated from the desktop's, plus Glass (system Liquid Glass on iOS 26 and later) | ADR-0051, ADR-0150 October 28 amendment |
| Five text-size steps applied on top of the system's Dynamic Type | `PhoneTextSize`, `Design.swift:330` |
| Sotto draws its own tab bar; the system one is hidden | ADR-0051 October 27 amendment, `TabsBar` in `Views.swift:145` |
| A Messages-like reply box 38 pt tall, with **+** beside it | ADR-0051 October 29 amendment, `ComposerMetrics` in `Design.swift:886` |

### What iOS 26 changed, and what still holds on iOS 17

| Area | iOS 26 (built with Xcode 26) | iOS 17 to 25 (same binary) |
|---|---|---|
| Bars | Toolbar items sit on Liquid Glass "that floats above your app's content" and are "automatically grouped" ([Build a SwiftUI app with the new design, 7:43](https://developer.apple.com/videos/play/wwdc2025/323/)). | Opaque or blurred bars. |
| Tab bar | "floats above content at the bottom of the screen" on Liquid Glass ([HIG Tab bars › iOS](https://developer.apple.com/design/human-interface-guidelines/tab-bars)); can minimize on scroll with `tabBarMinimizeBehavior` (iOS 26.0) ([323, 4:45](https://developer.apple.com/videos/play/wwdc2025/323/)). | Fixed bar along the bottom. |
| Sheets | "partial height sheets are inset by default with a Liquid Glass background"; remove a custom `presentationBackground` ([323, 6:17](https://developer.apple.com/videos/play/wwdc2025/323/)). | Edge-to-edge sheets. |
| Buttons | "Bordered buttons now have a capsule shape by default"; `.glass` and `.glassProminent` styles ([323, 14:00](https://developer.apple.com/videos/play/wwdc2025/323/)). | Rounded rectangles. |
| Edges | A scroll edge effect replaces backgrounds behind bars; "remove" extra backgrounds or darkening behind bar items ([323, 10:14 and 10:46](https://developer.apple.com/videos/play/wwdc2025/323/)). | Bar backgrounds. |
| Search | In a toolbar the field moves to the bottom of the screen; or it is a tab of its own ([323, 11:18](https://developer.apple.com/videos/play/wwdc2025/323/)). | Field under the title. |
| Menus and action sheets | Spring from the control that opened them; action sheets no longer always come from the bottom ([Get to know the new design system, 6:32](https://developer.apple.com/videos/play/wwdc2025/356/)). | From the bottom. |
| Colour and type | System colours "adjusted" across Light, Dark and Increased Contrast; type "bolder and left-aligned" in alerts and onboarding ([356, 2:33](https://developer.apple.com/videos/play/wwdc2025/356/)). | Earlier values. |
| New APIs | `glassEffect(_:in:)`, `ConcentricRectangle`, `scrollEdgeEffectStyle(_:for:)`, `tabBarMinimizeBehavior(_:)` are all iOS 26.0 and need `#available` (SwiftUI reference pages). | Not available. |

**Holds on every version:** 44 pt targets, Dynamic Type, contrast, safe areas, haptic meanings, push for hierarchy and modal for a task, Reduce Motion and Reduce Transparency. Even an app with one appearance must "provide both light and dark colors to support Liquid Glass adaptivity" ([HIG Color › Best practices](https://developer.apple.com/design/human-interface-guidelines/color)).

## How to run the review on the iPhone

1. **Screenshot matrix.** Apple says to test "the largest and the smallest layouts" first ([HIG Layout › Adaptability](https://developer.apple.com/design/human-interface-guidelines/layout)). Capture each page on the smallest and largest phones CI uses (iPhone SE, iPhone 16 Pro Max), and at regular width (the Duo unfolded, or a Max held sideways; ADR-0151). For each: dark and light; Sotto plus one other palette, and Glass on iOS 26; default text and the largest accessibility size (AX5), plus Sotto's Largest step; the keyboard up on a thread and on Watcher. Then once each with Reduce Motion, Reduce Transparency, Increase Contrast, Bold Text and Button Shapes. CI's captures (SE at default text; 16 Pro Max at an accessibility size with Reduce Motion) are in `~/ui-hillclimb/ios/`.
2. **Touch walk.** Do every task with taps only, then with VoiceOver, then with Voice Control. Note any action that only a gesture reaches (2.2).
3. **Code pass.** Run the greps in section 5.
4. **Rank** with the desktop rubric's section 6. On the iPhone, severity 1 also covers a control smaller than 28 by 28 pt, a target under 24 pt whose 24 pt circle overlaps a neighbour's (WCAG 2.5.8), text clipped or overlapping at AX5, and an action only a gesture reaches.

## 1. Look

### 1.1 Hierarchy and layout

- Put the most important items "near the top and leading side". Align to show relation; indent to show subordination. Group with "negative space, container shapes, or separator lines" ([HIG Layout › Visual hierarchy](https://developer.apple.com/design/human-interface-guidelines/layout)).
- "Differentiate controls from content." Use Liquid Glass and a scroll edge effect for controls "instead of applying a solid or semi-opaque background color beneath controls" (same section).
- "Help people concentrate on primary tasks and content by limiting the number of onscreen controls while making secondary details and actions discoverable with minimal interaction." Controls in the "middle or bottom area of the display" are easier to reach ([HIG Designing for iOS › Best practices](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios)).
- "Instead of relying on decoration, hierarchy should be expressed through layout and grouping" ([356, 8:33](https://developer.apple.com/videos/play/wwdc2025/356/)).
- Spacing, rhythm and the spacing scale: desktop rubric 1.2.

**Check:** squint at each capture. The first thing seen should be the page's main content, and the eye should land top-leading.

### 1.2 Margins, safe areas and size classes

- "Respecting the safe area is essential to make sure system UI and hardware features like the Dynamic Island don't obstruct content and controls" ([HIG Layout › Guides and safe areas](https://developer.apple.com/design/human-interface-guidelines/layout)). SwiftUI keeps views out of the safe areas by default, which "ensures that system content like the software keyboard or edges of the device don't obstruct your views"; `ignoresSafeArea` is for extending into them on purpose ([`ignoresSafeArea(_:edges:)`](https://developer.apple.com/documentation/swiftui/view/ignoressafearea(_:edges:))).
- "Determine layout based on size classes, not device type or orientation." "Keep functionality the same as size classes change" ([HIG Layout › Size classes](https://developer.apple.com/design/human-interface-guidelines/layout)).
- Layout guides "restrict the width of text for optimal readability" (same page, Guides and safe areas). Sotto keeps 680 pt at regular width (`readingWidth()`, ADR-0151).
- The Duo's cover screen puts an 84 pt trailing inset in the window; iOS 27.1 moves trailing bar items into it (ADR-0151 amendments). That is Sotto's own finding, not in the HIG pages read.

**Check:** nothing under the status bar, Dynamic Island or home indicator except backgrounds. Landscape on a Max keeps the notch clear. Full-bleed backgrounds reach the edges; text and controls do not.

### 1.3 Type and Dynamic Type

**Sizes.** iOS default 17 pt, minimum 11 pt, for "both custom and system fonts" ([HIG Typography › Ensuring legibility](https://developer.apple.com/design/human-interface-guidelines/typography)). Part of the iOS Dynamic Type table, in points, size/leading (same page, Specifications):

| Style | xSmall | Large (default) | AX5 | Sotto's nearest step at default (`TextScale`, `Design.swift:220`) |
|---|---|---|---|---|
| Large Title | 31/38 | 34/41 | 60/70 | none |
| Title 1 | 25/31 | 28/34 | 58/68 | `display` 28, relative to `.title` |
| Title 3 | 17/22 | 20/25 | 55/65 | `title` 21, relative to `.title3` |
| Headline (semibold) | 14/19 | 17/22 | 53/62 | none |
| Body | 14/19 | 17/22 | 53/62 | `lead` 17 and `body` 15.5, both relative to `.body` |
| Footnote | 12/16 | 13/18 | 44/52 | `small` 13.5, relative to `.footnote` |
| Caption 1 | 11/13 | 12/16 | 43/51 | `caption` 12, relative to `.caption` |

Sotto's running text, `body`, is 15.5 pt where iOS's default body is 17. It is above the 11 pt minimum, but it is a deliberate departure from the platform default worth knowing about when a capture looks small.

**Rules.**

- Avoid Ultralight, Thin and Light; "prefer Regular, Medium, Semibold, or Bold" (Typography › Ensuring legibility). "Minimize the number of typefaces you use" (Conveying hierarchy).
- **Custom fonts.** "If you use a custom font, make sure it implements the same behaviors", Dynamic Type and Bold Text (Typography › Using custom fonts). In SwiftUI, `Font.custom(_:size:relativeTo:)` scales with a text style ([reference](https://developer.apple.com/documentation/swiftui/font/custom(_:size:relativeto:))); in UIKit, `UIFontMetrics.scaledFont(for:)` ([reference](https://developer.apple.com/documentation/uikit/uifontmetrics)). "SwiftUI doesn't synthesize bold or italic styling for fonts" ([Applying custom fonts to text](https://developer.apple.com/documentation/swiftui/applying-custom-fonts-to-text)), so the Bold Text setting reaches a custom font only if the app reads `legibilityWeight`, which "reflects the value of the Bold Text display setting" ([reference](https://developer.apple.com/documentation/swiftui/environmentvalues/legibilityweight)).
- Scale spacing around text with `@ScaledMetric` (Applying custom fonts to text › Scale padding).
- **At large sizes.** "Keep text truncation to a minimum"; aim to show "as much useful text at the largest accessibility font size as you do at the largest standard font size"; stack inline items under text; "Reduce the number of columns"; keep primary elements toward the top (Typography › Supporting Dynamic Type). Switch an `HStack` to a `VStack` at accessibility sizes, and let decorative images stay small while text wraps under them ([Get started with Dynamic Type, 6:06 and 9:14](https://developer.apple.com/videos/play/wwdc2024/10074/)).
- **Icons grow too.** "Increase the size of meaningful interface icons as font size increases"; SF Symbols do it when they take a text style (Typography › Supporting Dynamic Type). A symbol set with `.font(.system(size:))` does not.
- **Custom bars.** System bars keep their height and show the Large Content Viewer on a long press; "if you choose to implement custom bars or views, consider adopting the large content viewer" ([10074, 12:50](https://developer.apple.com/videos/play/wwdc2024/10074/)) with `accessibilityShowsLargeContentViewer()` (iOS 15). Apple: use it only "where items must remain small due to unavoidable design constraints", such as tab bar buttons ([reference](https://developer.apple.com/documentation/swiftui/view/accessibilityshowslargecontentviewer())).
- Prioritise: people "don't expect the tab titles to increase in size" when they enlarge text (Typography › Conveying hierarchy).

**Check:** at AX5, no clipped or overlapping text, no title cut to one line where it could wrap, rows grow, horizontal groups stack. With Bold Text on, Figtree gets heavier. A long press on each tab shows its name.

### 1.4 Colour and contrast

- Contrast, as Accessibility Inspector applies it (WCAG AA): text up to 17 pt 4.5:1; 18 pt and over 3:1; bold text 3:1 ([HIG Accessibility › Vision](https://developer.apple.com/design/human-interface-guidelines/accessibility)). For custom colours "strive for a contrast ratio of 7:1, especially in small text" ([HIG Dark Mode › Dark Mode colors](https://developer.apple.com/design/human-interface-guidelines/dark-mode)). Control boundaries and states need 3:1 against what is next to them ([WCAG 2.2, 1.4.11](https://www.w3.org/TR/WCAG22/#non-text-contrast)). WCAG's large text is "at least 18 point or 14 point bold" (WCAG 2.2 glossary).
- **Increase Contrast.** For a custom colour, supply light and dark variants "and an increased contrast option for each variant" (HIG Color › Best practices). If the app misses the minimums by default, it must "at least" provide a higher-contrast scheme when Increase Contrast is on (HIG Accessibility › Vision). Read it with `colorSchemeContrast` ([reference](https://developer.apple.com/documentation/swiftui/environmentvalues/colorschemecontrast)). "As a general rule, colors should get darker in Light Mode and lighter in Dark Mode" ([Make your app visually accessible, 5:52](https://developer.apple.com/videos/play/wwdc2020/10020/)).
- **Not by colour alone.** Use "text labels or glyph shapes" too (HIG Color › Inclusive color). Respect Differentiate Without Color (`accessibilityDifferentiateWithoutColor`: "UI should not convey information using color alone", [reference](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilitydifferentiatewithoutcolor)) and Button Shapes ([10020, 2:29](https://developer.apple.com/videos/play/wwdc2020/10020/)).
- "Avoid using the same color to mean different things" (HIG Color). "Apply your app's accent color judiciously": primary actions, status, the selected tab ([HIG Branding › Best practices](https://developer.apple.com/design/human-interface-guidelines/branding)).
- Colour roles in general: desktop rubric 1.4.

### 1.5 Light and dark

- "Avoid offering an app-specific appearance setting"; people "may think your app is broken because it doesn't respond to their systemwide appearance choice" ([HIG Dark Mode › Best practices](https://developer.apple.com/design/human-interface-guidelines/dark-mode)). Sotto offers Dark, Light and System with Dark the default (ADR-0039, ADR-0051). That is a recorded product decision, so the review notes it and does not score it.
- Test dark with Increase Contrast and Reduce Transparency, "both separately and together" (same page).
- iOS uses base and elevated backgrounds so a sheet over a page reads as nearer; a custom background colour "can make it harder for people to perceive" that (Dark Mode › iOS, iPadOS). With custom canvases, check that a sheet is visibly a step off the page beneath it.

### 1.6 Materials and Liquid Glass

| Rule | Source |
|---|---|
| Liquid Glass is "a distinct functional layer for controls and navigation elements". "Don't use Liquid Glass in the content layer"; use standard materials there. | [HIG Materials › Liquid Glass](https://developer.apple.com/design/human-interface-guidelines/materials) |
| "Use Liquid Glass effects sparingly"; on custom controls "limit these effects to the most important functional elements". | same |
| "Always avoid glass on glass." Put fills, transparency and vibrancy on what sits on glass instead. | [Meet Liquid Glass, 12:49](https://developer.apple.com/videos/play/wwdc2025/219/) |
| Regular works anywhere; Clear only over rich media, with a dimming layer ("35% opacity" over bright content), and never mixed with Regular. | HIG Materials; [219, 13:48](https://developer.apple.com/videos/play/wwdc2025/219/) |
| Tint "only to bring emphasis to primary elements and actions"; "When every element is tinted, nothing stands out." A solid fill instead of glass tinting "breaks the visual character of Liquid Glass". | [219, 16:50 and 17:21](https://developer.apple.com/videos/play/wwdc2025/219/); [HIG Color › Liquid Glass color](https://developer.apple.com/design/human-interface-guidelines/color) |
| "In steady states, such as when an app first launches, avoid intersections between content and Liquid Glass." | [219, 17:54](https://developer.apple.com/videos/play/wwdc2025/219/) |
| Reduce Transparency makes glass "frostier"; Increase Contrast makes it "predominantly black or white" with a border; Reduce Motion disables its elastic properties. You get these only from the system material. | [219, 18:22](https://developer.apple.com/videos/play/wwdc2025/219/) |
| Scroll edge effects "aren't decorative"; use one only behind floating UI, one per view, and prefer the automatic style. | [HIG Scroll views › Scroll edge effects](https://developer.apple.com/design/human-interface-guidelines/scroll-views) |
| Group neighbouring glass in a `GlassEffectContainer`: "glass can not sample other glass". "Limit the use of Liquid Glass effects onscreen at the same time" for performance. | [323, 19:47](https://developer.apple.com/videos/play/wwdc2025/323/); [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views) |
| Standard materials (ultra-thin, thin, regular, thick) stay for the content layer; avoid quaternary labels on thin and ultra-thin. | HIG Materials › iOS, iPadOS |

### 1.7 Corner radii and concentricity

- Three shapes: "fixed shapes have a constant corner radius. Capsules use a radius that's half the height of the container. And concentric shapes calculate their radius by subtracting padding from the parent's" ([356, 3:34](https://developer.apple.com/videos/play/wwdc2025/356/)). Watch for "corners that feel too pinched— or flared", often in "nested containers—like artwork in a card" ([356, 5:04](https://developer.apple.com/videos/play/wwdc2025/356/)).
- Near the screen edge on a phone, "use a capsule with extra margin" ([356, 5:34](https://developer.apple.com/videos/play/wwdc2025/356/)). Custom toolbar components should be concentric with the bar ([HIG Toolbars › Best practices](https://developer.apple.com/design/human-interface-guidelines/toolbars)).
- `ConcentricRectangle` (iOS 26) computes a corner from its container ([reference](https://developer.apple.com/documentation/swiftui/concentricrectangle)). On iOS 17 to 25, do the subtraction by hand.
- Capsules "bring focus and clarity to touch-friendly layouts" ([356, 4:04](https://developer.apple.com/videos/play/wwdc2025/356/)). On the iPhone a capsule control is native; a capsule around text that does nothing is the tell (5, row 15). That differs from the desktop's ADR-0110, which has no pill controls.
- Use `RoundedRectangle(..., style: .continuous)`: "Continuous curvature rounded rect corners" (`RoundedCornerStyle.continuous`, iOS 13). That this is the same curve as the system's own controls is (unverified); Apple says only that app icon masks "precisely match the curvature of other rounded interface elements throughout the system" ([HIG App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)).
- General radius rules: desktop rubric 1.7.

### 1.8 SF Symbols and icons

- Nine symbol weights match the system font's, "helping you achieve precise weight matching between symbols and adjacent text"; three scales (small, medium, large) adjust emphasis "without disrupting the weight matching" ([HIG SF Symbols › Weights and scales](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)). With Figtree, match by eye: a symbol's weight should look like the label's.
- Outline suits toolbars and lists; fill suits "iOS tab bars and swipe actions" and selection (same page, Design variants). Tab bars: "Prefer filled symbols" ([HIG Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)).
- All icons share "a consistent size, level of detail, stroke thickness (or weight), and perspective"; "match the weights of interface icons and adjacent text"; give custom icons an accessibility label ([HIG Icons › Best practices](https://developer.apple.com/design/human-interface-guidelines/icons)).
- "When there's no clear shorthand, a text label is always the better choice." For related menu items, "Use the symbol once to introduce the group, and let text do the rest" ([356, 15:32](https://developer.apple.com/videos/play/wwdc2025/356/)). Menu icons: "for all menu items in a group, or none of them" ([HIG Menus › Icons](https://developer.apple.com/design/human-interface-guidelines/menus)).
- Toolbar icons are monochrome in iOS 26; tint "to convey meaning ... but not just for visual effect" ([323, 9:44](https://developer.apple.com/videos/play/wwdc2025/323/)). Toolbars "Prefer system-provided symbols without borders" (HIG Toolbars › Actions).
- Few icons are universal; "text labels are necessary to communicate the meaning" ([NN/g, Icon Usability](https://www.nngroup.com/articles/icon-usability/)).

## 2. Interaction

### 2.1 Touch targets

| Measure | Value | Source |
|---|---|---|
| Default control size | 44 × 44 pt | [HIG Accessibility › Mobility](https://developer.apple.com/design/human-interface-guidelines/accessibility) |
| Minimum control size | 28 × 28 pt | same |
| Padding around a control with a bezel | about 12 pt | same |
| Padding around a control without a bezel | about 24 pt from its visible edges | same |
| WCAG AA minimum | 24 × 24, or spaced so 24-diameter circles don't overlap | [WCAG 2.2, 2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum) |
| WCAG AAA | 44 × 44 | [WCAG 2.2, 2.5.5](https://www.w3.org/TR/WCAG22/#target-size-enhanced) |
| Physical | at least 1 cm × 1 cm | [NN/g, Touch Targets on Touchscreens](https://www.nngroup.com/articles/touch-target-size/) |
| Thumb | 8 × 8 mm with 2 mm gaps (Nokia, as LukeW collects it) | [LukeW, Touch Target Sizes](https://www.lukew.com/ff/entry.asp?1085) |

- "Consider spacing between controls as important as size" (HIG Accessibility › Mobility). Targets must be big enough first, then spaced: spacing doesn't rescue a 2 mm button (NN/g, as above). NN/g's "view–tap asymmetry": large enough to read, too small to hit (same article).
- iOS's own bars and rows are 44 pt ([Bjango, Interaction density](https://bjango.com/articles/interactiondensity/)).
- A drawn glyph can be smaller than its press area. In SwiftUI the press area is the view's frame or `contentShape` ([reference](https://developer.apple.com/documentation/swiftui/view/contentshape(_:eofill:))).

**Check:** on the SE capture, measure every icon-only control and the gap to its neighbour. Anything under 44 pt needs a press area of 44; under 28 is severity 1.

### 2.2 Gestures, swipe actions and menus

- Standard meanings: tap activates; swipe reveals actions, dismisses or scrolls; touch and hold reveals more ([HIG Gestures › Standard gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)). "Avoid using a familiar gesture like tap or swipe to perform an action that's unique to your app" (Gestures › Best practices).
- A custom gesture must be discoverable, straightforward, distinct and "Not the only way to perform an important action" (Gestures › Custom gestures). "If you use a swipe gesture to dismiss a view, also make a button available" (HIG Accessibility › Mobility). WCAG: path-based gestures and dragging need a single-pointer alternative ([2.5.1](https://www.w3.org/TR/WCAG22/#pointer-gestures), [2.5.7](https://www.w3.org/TR/WCAG22/#dragging-movements)).
- Contextual swipe has a "Lack of signifiers"; users can't predict where it works ([NN/g, Contextual Swipe](https://www.nngroup.com/articles/contextual-swipe/)). "It's especially important to let people swipe to navigate back or initiate actions in a list row" (HIG Designing for iOS).
- `swipeActions` belongs to "a row in a list" and fills symbols automatically; the first action fires on a full swipe unless turned off ([reference](https://developer.apple.com/documentation/swiftui/view/swipeactions(edge:allowsfullswipe:content:))). Rows in a `ScrollView` of custom views don't get it.
- Context menus: "Always make context menu items available in the main interface, too"; support them "consistently throughout your app"; keep them short ([HIG Context menus › Best practices](https://developer.apple.com/design/human-interface-guidelines/context-menus)).

### 2.3 Haptics

- Standard toggles, sliders and pickers play haptics themselves. Feedback generators come in three kinds: notification for "the outcome of a task", impact to "complement a visual experience", selection "while the values of a UI element are changing" ([HIG Playing haptics › iOS](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)). `sensoryFeedback(_:trigger:)` is iOS 17 ([reference](https://developer.apple.com/documentation/swiftui/view/sensoryfeedback(_:trigger:))).
- "Use system-provided haptic patterns according to their documented meanings"; use them consistently; "Avoid overusing haptics"; "the best haptic experience is one that people may not be conscious of, but miss when it's turned off"; prefer short ones; make them optional (Playing haptics › Best practices).
- Causality, harmony, utility: a haptic should "feel the way" the motion looks, in sync with it ([Designing Audio-Haptic Experiences, 5:04 and 9:41](https://developer.apple.com/videos/play/wwdc2019/810/)).

**Check:** list every haptic trigger. Each should mark an outcome, a snap or a value change, and none should fire on a routine tap.

### 2.4 Navigation

- **Tab bar.** "Use a tab bar to support navigation, not to provide actions." Keep it visible across sections; "Don't disable or hide tab bar buttons, even when their content is unavailable"; single-word labels; "Reserve badges for critical information" ([HIG Tab bars › Best practices](https://developer.apple.com/design/human-interface-guidelines/tab-bars)). Avoid a "Home" tab that repeats other tabs' features; "Never force someone to change tabs automatically"; "Always keep the tab bar persistent throughout your app" ([Explore navigation design for iOS, 8:11 to 12:31](https://developer.apple.com/videos/play/wwdc2022/10001/)). Don't put "screen-specific actions" in the tab bar's accessory ([356, 10:36](https://developer.apple.com/videos/play/wwdc2025/356/)).
- **Push** for going deeper and for content people move between often: Messages pushes each conversation because a modal "would be difficult to seamlessly move between different chats"; a chevron always means push; the back button names where you came from ([10001, 13:30 to 18:17](https://developer.apple.com/videos/play/wwdc2022/10001/)).
- **Back.** "Use the standard Back and Close buttons"; don't label them "Back" or "Close" ([HIG Toolbars › Navigation](https://developer.apple.com/design/human-interface-guidelines/toolbars)). Things leave and return on "symmetric paths", which is what makes the back swipe feel right ([Designing Fluid Interfaces, 11:53](https://developer.apple.com/videos/play/wwdc2018/803/)).
- **Titles** under 15 characters; a large title shrinks into the bar on scroll (HIG Toolbars › Titles, › iOS).
- **Toolbar crowding.** "Choose items deliberately to avoid overcrowding"; at most three groups; don't put a text button beside a symbol button; one `.prominent` primary action on the trailing side (HIG Toolbars). "If your bar is feeling too crowded, use it as a cue to remove anything unnecessary" into a More menu ([356, 9:04](https://developer.apple.com/videos/play/wwdc2025/356/)).
- **Restore state** on relaunch, including scroll position ([HIG Launching › Best practices](https://developer.apple.com/design/human-interface-guidelines/launching)).
- Sotto chose to hide its tab bar under a thread (ADR-0051 October 27 amendment) and shows the Watcher tab only where a computer runs it (README). Both depart from the rules above for recorded reasons; note, don't score.

### 2.5 Sheets, pushes and full-screen covers

| Use | When | Source |
|---|---|---|
| Push | Deeper in the hierarchy, or content people move between often | [10001, 14:24](https://developer.apple.com/videos/play/wwdc2022/10001/) |
| Sheet | "a scoped task that's closely related to their current context"; not for navigating content | [HIG Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets), [HIG Modality](https://developer.apple.com/design/human-interface-guidelines/modality) |
| Medium detent | Progressive disclosure, like the share sheet; skip it when content needs full height, like Messages' compose | HIG Sheets › iOS, iPadOS |
| Full-screen cover | "in-depth content or a complex task": media, camera, a multistep edit | HIG Modality › Best practices |
| Confirmation dialog (action sheet) | Choices about an action the person started | [HIG Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets) |
| Alert | "critical — and ideally actionable — information" | [HIG Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) |

- "Display only one sheet at a time"; "Let people dismiss a modal view before presenting another one" (HIG Sheets, Modality); "limit modals over modals" ([10001, 23:04](https://developer.apple.com/videos/play/wwdc2022/10001/)).
- Cancel on the leading edge, Done on the trailing; a grabber on a resizable sheet; swipe to dismiss, with a confirmation if there are unsaved changes (HIG Sheets › iOS, iPadOS). Pair Done with Cancel or Back; never all three (Sheets › Best practices).
- Use the close symbol "only when modal presentations require minimal interaction and no text input" ([10001, 22:08](https://developer.apple.com/videos/play/wwdc2022/10001/)).
- Action sheets: destructive choices at the top, Cancel at the bottom, no scrolling ([HIG Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets)). `confirmationDialog` adds a dismiss action by default ([reference](https://developer.apple.com/documentation/swiftui/view/confirmationdialog(_:ispresented:titlevisibility:actions:))).
- Alerts: not "merely to provide information", not "for common, undoable actions", not "when your app starts" ([HIG Alerts › Best practices](https://developer.apple.com/design/human-interface-guidelines/alerts)). Undo over confirmation: desktop rubric 2.7.

### 2.6 Keyboard and the reply box

- "Use the keyboard layout guide to make the keyboard feel like an integrated part of your interface" and keep important parts visible above it. Controls placed above the keyboard should be "relevant to the current task", and in Liquid Glass if the rest of the app uses it ([HIG Virtual keyboards › iOS, iPadOS](https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards)). SwiftUI's safe area already includes the keyboard (`ignoresSafeArea` reference, above).
- Pick the keyboard and Return key for the content (`keyboardType`, `textContentType`, `submitLabel`) (Virtual keyboards › Best practices).
- `scrollDismissesKeyboard(_:)` (iOS 16) sets how scrolling dismisses the keyboard, for example "immediately ... when a scroll drag gesture begins" ([reference](https://developer.apple.com/documentation/swiftui/view/scrolldismisseskeyboard(_:))).
- When someone starts typing out of view, scroll back to the insertion point, but only as much as needed ([HIG Scroll views › Best practices](https://developer.apple.com/design/human-interface-guidelines/scroll-views)).
- A placeholder disappears as people type, so a field may need a separate label; offer a Clear button on the trailing end ([HIG Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)).
- With a hardware keyboard, support Full Keyboard Access and don't repurpose standard shortcuts ([HIG Keyboards › Best practices](https://developer.apple.com/design/human-interface-guidelines/keyboards)).

**Check:** with the keyboard up on the SE, the newest message and the box are both visible, the box doesn't jump as it grows, a scroll down dismisses the keyboard as designed, and Send, Stop and **+** keep 44 pt press areas.

### 2.7 Pull to refresh

- A refresh control is "hidden by default" until people drag down. Don't rely on it: "Don't make people responsible for initiating every update." Add a title "only if it adds value", never to explain how to refresh ([HIG Progress indicators › Refresh content controls](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)). SwiftUI: `refreshable(action:)` (iOS 15).

### 2.8 Waiting and latency masking

- Respond at once: "Everything needs to respond instantly", taps and presses included; "look for delays everywhere" ([Designing Fluid Interfaces, 5:39 to 6:32](https://developer.apple.com/videos/play/wwdc2018/803/)). Limits: 0.1 s feels instant, 1 s keeps flow, 10 s keeps attention ([NN/g, Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/)).
- "Show something as soon as possible": "placeholder text, graphics, or animations" replaced as content arrives; let people do other things meanwhile ([HIG Loading › Best practices](https://developer.apple.com/design/human-interface-guidelines/loading)). Restore the last state and show it ([HIG Launching](https://developer.apple.com/design/human-interface-guidelines/launching)); when offline, show "cached or placeholder data and a nonintrusive label" (HIG Alerts).
- Skeletons are for full-page loads; spinners suit a single module; nothing under 1 s; skeletons and spinners for under 10 s, progress bars beyond; a frame-only skeleton "is essentially equivalent to a spinner" ([NN/g, Skeleton Screens 101](https://www.nngroup.com/articles/skeleton-screens/)). SwiftUI has `redacted(reason: .placeholder)` (iOS 14).
- Prefer a determinate indicator; keep indicators moving; "Avoid vague terms like loading or authenticating"; one consistent location ([HIG Progress indicators › Best practices](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)). A button can show its own activity indicator and change its label, "Checkout" to "Checking out…" ([HIG Buttons › iOS, iPadOS](https://developer.apple.com/design/human-interface-guidelines/buttons)).
- Optimistic display with an honest state is what Sotto does for answers: Sending, then Answered or No longer waiting (ADR-0051). General waiting rules: desktop rubric 2.6.

### 2.9 Motion and Reduce Motion

- "Add motion purposefully"; "generally avoid adding motion to UI interactions that occur frequently"; "Let people cancel motion"; "Make motion optional" ([HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion)).
- Under Reduce Motion: tighten springs, track gestures directly, don't animate depth on the z-axis, replace x, y and z transitions with fades, and avoid animating into and out of blurs ([HIG Accessibility › Cognitive](https://developer.apple.com/design/human-interface-guidelines/accessibility)). Prefer Cross-Fade Transitions also applies to custom slides ([10020, 13:05](https://developer.apple.com/videos/play/wwdc2020/10020/)). WCAG AAA: motion from interaction can be turned off ([2.3.3](https://www.w3.org/TR/WCAG22/#animation-from-interactions)).
- Springs: start at "100% damping, or no overshoot"; give bounce only when "the gesture that's driving the motion itself has momentum" ([803, 36:14](https://developer.apple.com/videos/play/wwdc2018/803/)). Springs keep velocity continuous; linear motion "generally feels out of place" except a spinner ([Animate with springs, 3:58](https://developer.apple.com/videos/play/wwdc2023/10158/)).
- Allow redirection mid-gesture and hint in the gesture's direction ([803, 6:59 and 13:14](https://developer.apple.com/videos/play/wwdc2018/803/)). Durations and the general motion rules: desktop rubric 2.3.

### 2.10 VoiceOver basics

- Every icon-only control has a label that says what a press does; custom icons need "alternative text labels" ([HIG Icons](https://developer.apple.com/design/human-interface-guidelines/icons)). Label elements for Voice Control too (HIG Accessibility › Mobility).
- Group what reads as one thing (`accessibilityElement(children: .combine)`), mark headings with the header trait, and post an announcement for news that isn't focused (Sotto's toast does: `ToastPresenter`, `Design.swift:1708`).
- A grabber "works with VoiceOver so people can resize the sheet without seeing the screen" (HIG Sheets).
- "Minimize use of time-boxed interface elements"; "Prefer dismissing views with an explicit action" (HIG Accessibility › Cognitive; WCAG [2.2.1](https://www.w3.org/TR/WCAG22/#timing-adjustable)).
- Check with Accessibility Inspector's audit, which finds clipped text, missing labels and low contrast ([10074, 5:40](https://developer.apple.com/videos/play/wwdc2024/10074/)).

## 3. Simplicity

The general case (fewer elements, one primary action, chrome recedes, labels say what a press does) is desktop rubric section 3. What iOS sources add:

- **Limit what's on screen; keep the rest one step away** (HIG Designing for iOS, above). Progressive disclosure "gradually eases people from the simple to the more complex", but "the same technique can bury information or functionality", and "Too much progressive disclosure can make work flows inefficient" ([Essential Design Principles, 47:34, 48:58 and 57:12](https://developer.apple.com/videos/play/wwdc2017/802/)).
- **Obvious always wins.** Polar's and Zeebox's engagement fell when sections moved behind a menu; Facebook's rose with a bottom tab bar ([LukeW, Obvious Always Wins](https://www.lukew.com/ff/entry.asp?1945)).
- **One or two prominent buttons per view**, and use "style — not size" to mark the preferred one ([HIG Buttons › Style](https://developer.apple.com/design/human-interface-guidelines/buttons)). One `.prominent` toolbar action (HIG Toolbars).
- **Branding defers to content.** Don't spend space on a brand asset; "Resist the temptation to display your logo throughout your app"; "Express your brand with familiar components" ([HIG Branding](https://developer.apple.com/design/human-interface-guidelines/branding)).
- **Remove decoration from bars.** "We've all added extra backgrounds or borders to give buttons the right weight ... making customizations like these unnecessary" ([356, 8:33](https://developer.apple.com/videos/play/wwdc2025/356/)).
- **Internal consistency.** Glyphs "should have a consistent visual style"; text "should have a limited number of font faces and sizes and colors" ([802, 26:34](https://developer.apple.com/videos/play/wwdc2017/802/)).
- **Confirm what matters.** "Every action taken in your app should provide some form of confirmation feedback" ([802, 16:07](https://developer.apple.com/videos/play/wwdc2017/802/)), but explicit confirmations are for "activities that are sufficiently important" ([HIG Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)). Reconcile them: the visible result is the feedback; a toast or banner only for what people can't see.
- **Static decoration dates.** iOS 7 dropped static shadows because they were "unresponsive to the actual environment of the user" ([Lux, Physicality: the new age of UI](https://www.lux.camera/physicality-the-new-age-of-ui/)). A glow drawn the same whatever is behind it is the same kind of decoration.

**Check:** per page, count accent-filled controls (one, at most two), lit or glowing elements, and signals for the same fact. For each element, ask what breaks if it goes.

## 4. What Sotto's iPhone design rules already get right

From the ADRs and `apps/ios/Sotto/Design.swift` (line numbers at `e1f838016`). These are the rules; whether every page follows them is the review's job.

| Rule in Sotto | Matches | Where |
|---|---|---|
| One type scale, each step tied to a text style, so Dynamic Type and the text-size step scale together; UIKit text uses `UIFontMetrics` | Typography › Using custom fonts; Applying custom fonts to text | `TextScale`, `Font.figtree`, `UIFont.figtree`, `Design.swift:220-277` |
| Static Figtree faces because iOS won't synthesize weights | "SwiftUI doesn't synthesize bold" | `apps/ios/README.md` › Bundled assets |
| The text-size step never shrinks an accessibility size iOS asks for | Typography › Supporting Dynamic Type | `PhoneTextSize.applied`, `Design.swift:330-352`; ADR-0051 › Settings |
| One spacing scale (4 to 44) and a 20 pt gutter; four radius tokens; continuous corners on cards | Internal consistency (WWDC17) | `Space`, `Radius`, `Design.swift:279-313`, `CardSurface` `:928` |
| Colour only from theme roles, palettes generated from the desktop's and tested for drift | HIG Color | `ThemeRole`, `Palette`, `Design.swift:173-215`; README › Bundled assets |
| Every custom button style has a press state, a dim instead of a shrink under Reduce Motion | HIG Buttons › Best practices; Accessibility › Cognitive | `PressStyle`, `PillBody`, `ChipBody`, `Design.swift:1424-1579` |
| Smaller drawn buttons keep a 44 pt press area, and Stop and Send sit far enough apart that theirs don't overlap | HIG Accessibility › Mobility; WCAG 2.5.8 | `pressArea(drawn:)`, `ComposerMetrics.buttonGap`, `Design.swift:886-912`; ADR-0051 October 29 |
| Chips and pills are at least 44 pt tall | 44 pt default | `Design.swift:1469`, `:1566` (compact pills are 40) |
| One accent action per surface | HIG Buttons › Style | `ActionStyle`, `Design.swift:1498` |
| Glass only on floating chrome (pinned bar, reply box, request dock, toasts, menus); cards are content and stay frosted | HIG Materials: no Liquid Glass in the content layer | ADR-0150 October 28 amendment |
| Liquid Glass only behind `#available(iOS 26, *)`, with a frosted or solid fallback | iOS 17 floor | `GlassSurface`, `ComposerSurface`, `PillGround`, `Design.swift:821-884`, `:1610` |
| Reduce Transparency turns glass solid; Reduce Motion turns movement into fades and stops the breathing | HIG Accessibility; WWDC20 | `GlassSurface` `:838`; ADR-0051 › The look |
| No SwiftUI `.shadow` and no `repeatForever`; loops in Core Animation (0 hits today) | Performance of an always-on look | ADR-0051 October 6 amendments |
| Section headings in sentence case, with the header trait | NN/g on all caps; VoiceOver | `SectionHeading`, `SectionLabel`, `Design.swift:1388-1419` |
| VoiceOver hears the fact, not the working words; a toast is announced | HIG Accessibility › Vision | ADR-0051 October 24; `ToastPresenter` `:1708` |
| Confirmations leave by themselves; refusals and errors stay until dismissed | HIG Feedback; Accessibility › Cognitive (for errors) | ADR-0051 October 27 |
| Layout follows the size class; a 680 pt reading width at regular width; columns collapse to one at accessibility sizes | HIG Layout › Size classes; Typography › Supporting Dynamic Type | `readingWidth()`, `Design.swift:296-306`; ADR-0151 › Decision |
| Wide tables become one card per row, so nothing scrolls sideways | Typography: avoid truncation | ADR-0051 › The thread page |
| Questions and permissions first, Settled collapsed; answering shows Sending, then Answered | Progressive disclosure; honest feedback | ADR-0039, ADR-0051 › Answering on a card |
| Notifications off until turned on; iOS asks permission at the first one | Ask in context | ADR-0051 › Settings |

### Where Sotto's rules and the sources part

Leads, not findings; the screenshots decide. The first group is recorded decisions: note them, don't score them.

- **Recorded decisions.** An in-app appearance setting, Dark by default (HIG Dark Mode says avoid; ADR-0039). The tab bar hides under a thread, and the Watcher tab comes and goes (HIG Tab bars, WWDC22; ADR-0051, README). Confirmations time out after 5 s, and the toast after 2.6 s (`Design.swift:1708`) (HIG Accessibility › Cognitive; ADR-0051 October 27). The accent action stays solid under Glass to keep its label's contrast (WWDC25 219 suggests tinted glass; ADR-0150).
- **Body text is 15.5 pt** at the default size, against iOS's 17 (`TextScale.body`).
- **Sotto's own tab bar has no Large Content Viewer.** `accessibilityShowsLargeContentViewer` has 0 hits. The shared notes add that a press on the chosen tab doesn't scroll back to the top.
- **Bold Text probably doesn't reach Figtree.** `legibilityWeight` has 0 hits, and SwiftUI doesn't synthesize bold. Confirm on a device.
- **No increased-contrast palettes.** `ThemePalettes.swift` has light and dark swatches only, and `colorSchemeContrast` has 0 hits (HIG Color, Accessibility).
- **Differentiate Without Color is never read** (0 hits). The failed edge, the warm glow and the wash carry state in colour; check that words carry it too.
- **57 views, nearly all SF Symbols, are sized with `.font(.system(size:))`** at eleven literal sizes from 9 to 24 pt. They won't grow with Dynamic Type while the Figtree beside them does.
- **Soft pills and unchosen chips become interactive Liquid Glass under Glass** (`PillGround`, `Design.swift:1610`). Where they sit in the content layer, that runs against HIG Materials.

## 5. Vibe-coded tells on the iPhone

"Vibe-coded" here means SwiftUI that looks generated or ported from the web: it ignores the platform's components and defaults. For the general tells and their fixes (gradients, card nesting, radii, shadows, sizes and weights, all caps, centring, spinners, toasts, modals, icon soup), see desktop rubric section 5. This table keeps the iOS reason, a screenshot cue and a grep.

Run each pattern as `grep -rnE '<pattern>' apps/ios/Sotto --include=*.swift`. "Today" is the hit count at `e1f838016`.

| # | Tell | Why it hurts (source) | Spot it in a screenshot | Spot it in SwiftUI (today) |
|---|---|---|---|---|
| 1 | Web-like layout | Familiar components feel "immediately reliable" (HIG Branding); "The best way to adopt the new design is to use standard app structures, toolbars, search placements, and controls" (WWDC25 323, 17:38) | A centred column of cards under a custom hero; no title or back chevron; "Learn more →" links; a hamburger | `ScrollView` pages with no `List`, `Form` or `navigationTitle`; `toolbar(.hidden` or `navigationBarHidden`; `frame(maxWidth: [0-9]+)` centring (`ScrollView` 39, `List` 2). Sotto's own sheet pages are an ADR choice; flag drift from them, not them. |
| 2 | Custom controls where system ones fit | System controls bring states, haptics (HIG Playing haptics), Liquid Glass (WWDC25 323) and the Large Content Viewer (WWDC24 10074) for free | A switch, segmented control, menu or sheet that doesn't look or move like iOS's | `struct [A-Za-z]*(Toggle\|Picker\|Segment\|TabBar\|Sheet\|Popover)[A-Za-z]*: View`; `ZStack` overlays with `transition(.move(edge: .bottom))` |
| 3 | Inconsistent corner radii, not concentric | Fixed, capsule or concentric only; "corners that feel too pinched— or flared" (WWDC25 356, 3:34) | Inner corners pinched or flared against their card; radii change from page to page | `cornerRadius: [0-9]` (30); `\.cornerRadius\(`; `RoundedRectangle\(cornerRadius: [^)]*\)$` without `.continuous` |
| 4 | Too many sizes or weights; SF mixed into Figtree | "Minimize the number of typefaces" (HIG Typography); limited faces and sizes (WWDC17 802, 26:34) | More than about five sizes on a screen; SF glyphs and text beside Figtree | `\.font\(\.system\(size:` (57); `\.font\(\.(title\|headline\|body\|caption)` beside `.sotto(`; `fontWeight\(` |
| 5 | Ignores Dynamic Type | Apps that don't respond "can be difficult or impossible to use" (HIG Layout); keep truncation down (HIG Typography) | At AX5: clipped or overlapping labels, titles cut to one line, rows that don't grow, icons that stay small | `Font\.custom\([^)]*size:[^)]*\)` without `relativeTo`; `UIFont\(name:` without `UIFontMetrics`; `lineLimit\(1\)` on titles (44); `minimumScaleFactor` (5); `dynamicTypeSize\(\.\.\.` caps (0); no `isAccessibilitySize` |
| 6 | Hard-coded frame sizes | Views must resize with text and size class (HIG Layout › Adaptability) | Fixed-width boxes that leave gaps on a Max or overflow on an SE | `\.frame\(width: [0-9]+, height: [0-9]+` (30); `UIScreen\.main` (0); `GeometryReader` used to size text (17) |
| 7 | Fixed heights that clip at large text | Rows "may need to grow in height so that text isn't cropped" (HIG Layout) | Text cut off at the bottom of a row, a pill or the reply box at AX sizes | `\.frame\((height\|maxHeight): [0-9]+` (31) on anything holding text; `fixedSize\(` (120) inside fixed frames; fix with `minHeight`, `@ScaledMetric` (6) or `ViewThatFits` |
| 8 | Tiny tap targets, or targets too close | 44 × 44 default, 28 × 28 minimum, 12 or 24 pt of padding (HIG Accessibility); WCAG 2.5.8 | Icon-only controls under about 30 pt, neighbours under 8 pt apart, an X in a corner | `\.frame\(width: (1[0-9]\|2[0-9]\|3[0-9]), height:` on a `Button` label without `contentShape` (49) or `pressArea(drawn:` (5); `controlSize\(\.(mini\|small)\)` |
| 9 | Tap handlers on non-buttons | "Always include a press state" (HIG Buttons); a button trait for VoiceOver and Voice Control | Something tappable that doesn't dim or shrink when pressed | `onTapGesture` (1); `TapGesture\(`; check for `accessibilityAddTraits\(\.isButton\)` |
| 10 | Gesture-only actions | A custom gesture is "Not the only way" (HIG Gestures); offer a button (HIG Accessibility); WCAG 2.5.1, 2.5.7 | An action you can't find without knowing to long-press or swipe | `onLongPressGesture\|LongPressGesture\|DragGesture` without a matching `Button`; `contextMenu` (2) items missing from the page |
| 11 | Cramped toolbars on narrow phones | Avoid overcrowding, at most three groups, titles under 15 characters (HIG Toolbars); move extras to a More menu (WWDC25 356, 9:04) | On the SE: the title truncated beside three or four icons, icons touching, a text button run into a symbol | `ToolbarItem(Group)?\(` with more than three items in one view; `placement: \.(topBarTrailing\|navigationBarTrailing)` repeated; text and symbol buttons side by side |
| 12 | Icon soup, mixed styles, emoji as icons | Consistent "size, level of detail, stroke thickness" (HIG Icons); all or none in a group (HIG Menus); text when no clear symbol (WWDC25 356, 15:32); labels needed (NN/g) | An icon on every row and heading; outline beside fill; odd sizes; emoji standing in for symbols | `Image\(systemName:` per view (73 total); a mix of `.fill"` and outline names in one group; `symbolRenderingMode\(\.multicolor` (0); emoji literals `grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]'` (0) |
| 13 | Over-badging and repeated status | "Reserve badges for critical information" (HIG Tab bars); indicators add noise (NN/g Indicators) | A badge, a dot, a glow, a wash and a section all saying one thing | `\.badge\(` (0); custom badge views and red `Circle()` fills; count the views that read one state (such as Needs you) |
| 14 | Gradient and glow overuse | "Apply color sparingly" to glass (HIG Color); "When every element is tinted, nothing stands out" (WWDC25 219, 17:21); accent "judiciously" (HIG Branding) | Several halos at once, coloured glows under several buttons, gradient washes behind sections | `LinearGradient\|RadialGradient\|AngularGradient` (11); `\.glow\(` (12); `softShadow\(`; `\.blur\(radius:`. Judge at Sotto's Glow slider default, 50 (ADR-0051 October 28). |
| 15 | Glass misused (iOS 26) | Not in the content layer, no glass on glass, sparingly (HIG Materials, WWDC25 219); remove bar backgrounds (WWDC25 323) | Rows or cards made of glass; glass pills inside a glass bar; dark bands behind bars; a glass control with a solid fill | `glassEffect\(` (5) on content views; `ultraThinMaterial` on rows; `toolbarBackground\(`; `presentationBackground\(`; adjacent glass without `GlassEffectContainer` |
| 16 | Cards inside cards | Nested containers need concentric corners (WWDC25 356, 5:04); background levels show grouping (HIG Color › iOS, iPadOS) | A card holding a card holding a chip row; three nested radii | `sottoCard\(\|\.card\(\)` applied inside another card's content; `RoundedRectangle` backgrounds three deep |
| 17 | Pills and chips everywhere | Capsules are for touch controls (WWDC25 356, 4:04); a pill that does nothing is a false affordance (desktop rubric 5) | Capsules around static status, counts or metadata; every word in a chip | `Capsule\(\)` (55) as a background of a `Text` outside a `Button` |
| 18 | Centred everything | Reading starts at the leading side (HIG Layout); alerts and onboarding moved to left-aligned (WWDC25 356, 2:33) | Centred paragraphs, centred empty states with long text, centred forms | `multilineTextAlignment\(\.center\)` (7); `VStack\(` with no `alignment:`, since the default is `.center` (SwiftUI `VStack.init`); `frame\(maxWidth: \.infinity\)` without `alignment: .leading` |
| 19 | All-caps micro labels | Use all caps "sparingly or not at all" (NN/g, 113 homepage guidelines); fine for one glanceable word (NN/g, Glanceable fonts) | Tracked-out CAPS eyebrows over sections | `textCase\(\.uppercase\)\|\.uppercased\(\)` (0); `Text\("[A-Z][A-Z ]{3,}"\)`; `tracking\(\|kerning\(` (1) |
| 20 | A spinner for a whole page | "Show something as soon as possible" (HIG Loading); skeletons for full pages, nothing under 1 s (NN/g Skeletons); no "Loading" labels (HIG Progress indicators) | A blank page with a centred spinner; "Loading…"; a spinner that flashes | `ProgressView\(\)` (22) as the only body of a loading branch; `redacted\(reason:` (0); `Text\("Loading` |
| 21 | Toasts for everything, banners on timers | Confirm only "sufficiently important" results (HIG Feedback); "Minimize use of time-boxed interface elements" (HIG Accessibility); WCAG 2.2.1 | A toast after an action whose result is already visible; an error that fades | `\.toast\(` (2); `Task\.sleep` before clearing a message; errors routed through a toast |
| 22 | Modal overuse, and the wrong dismiss | Modal only "when there's a clear benefit" (HIG Modality); one sheet at a time (HIG Sheets); push for content (WWDC22 10001); X only with no input (10001, 22:08); no "Back" or "Close" text (HIG Toolbars) | A sheet over a sheet; detail shown as a sheet where a push fits; an alert that only informs; an X on a form | `\.sheet\(` (10); `fullScreenCover` (3); `\.alert\(` (2); a `.sheet` inside sheet content; `Text\("(Back\|Close)"\)`; `xmark` in views with a `TextField` |
| 23 | Ignores safe areas | Safe areas keep the Dynamic Island and home indicator clear (HIG Layout) | Content under the status bar or home indicator; controls in the bottom edge; landscape notch clipping | `ignoresSafeArea` (12) on anything but backgrounds; `edgesIgnoringSafeArea`; `padding\(\.(top\|bottom), [3-9][0-9]\)` faking a bar's height; `\.offset\(y:` |
| 24 | Colour as the only signal, and the edge stripe | Not by colour alone (HIG Color, Accessibility); Differentiate Without Color; the coloured left-edge stripe is a stock AI-UI tell (shared notes) | A state shown only by a tint, glow or 3 pt bar | `FailedEdge\|failedEdge\(`; `accessibilityDifferentiateWithoutColor` (0) |
| 25 | Haptics everywhere, or the wrong one | Documented meanings, consistent, "Avoid overusing" (HIG Playing haptics) | (feel it on a device) | `sensoryFeedback\|FeedbackGenerator` (30); map each trigger to outcome, snap or selection |
| 26 | Bouncy or slide motion everywhere | Start without overshoot; bounce only after momentum (WWDC18 803, 36:14); fades under Reduce Motion (HIG Accessibility) | Taps that wobble; slides that stay slides with Reduce Motion on | `\.bouncy\|\.snappy\|dampingFraction: 0\.[0-7]`; `transition\(\.move` or `\.slide` without an `accessibilityReduceMotion` branch; `repeatForever` (0) |

## Sources

Apple Human Interface Guidelines, read 2026-10-29 from `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`; cite the page at `https://developer.apple.com/design/human-interface-guidelines/<page>`. Pages used: accessibility, action-sheets, alerts, app-icons, branding, buttons, color, context-menus, dark-mode, designing-for-ios, feedback, gestures, icons, keyboards, launching, layout, lists-and-tables, loading, materials, menus, modality, motion, playing-haptics, progress-indicators, scroll-views, sf-symbols, sheets, tab-bars, text-fields, toolbars, typography, virtual-keyboards. Also read but not cited: disclosure-controls, entering-data, inclusion, onboarding, popovers, pull-down-buttons, right-to-left, search-fields, searching, segmented-controls, toggles, writing.

WWDC sessions (transcripts on each page):

- Essential Design Principles, WWDC17 <https://developer.apple.com/videos/play/wwdc2017/802/>
- Designing Fluid Interfaces, WWDC18 <https://developer.apple.com/videos/play/wwdc2018/803/>
- Designing Audio-Haptic Experiences, WWDC19 <https://developer.apple.com/videos/play/wwdc2019/810/>
- Make your app visually accessible, WWDC20 <https://developer.apple.com/videos/play/wwdc2020/10020/>
- Explore navigation design for iOS, WWDC22 <https://developer.apple.com/videos/play/wwdc2022/10001/>
- Animate with springs, WWDC23 <https://developer.apple.com/videos/play/wwdc2023/10158/>
- Get started with Dynamic Type, WWDC24 <https://developer.apple.com/videos/play/wwdc2024/10074/>
- Meet Liquid Glass, WWDC25 <https://developer.apple.com/videos/play/wwdc2025/219/>
- Get to know the new design system, WWDC25 <https://developer.apple.com/videos/play/wwdc2025/356/>
- Build a SwiftUI app with the new design, WWDC25 <https://developer.apple.com/videos/play/wwdc2025/323/>

Apple developer documentation, under `https://developer.apple.com/documentation/`: `swiftui/applying-custom-fonts-to-text`, `swiftui/applying-liquid-glass-to-custom-views`, `swiftui/font/custom(_:size:relativeto:)`, `swiftui/scaledmetric`, `swiftui/environmentvalues/legibilityweight`, `.../colorschemecontrast`, `.../accessibilitydifferentiatewithoutcolor`, `.../accessibilityreducemotion`, `swiftui/view/accessibilityshowslargecontentviewer()`, `.../scrolldismisseskeyboard(_:)`, `.../ignoressafearea(_:edges:)`, `.../safeareainset(edge:alignment:spacing:content:)`, `.../presentationdetents(_:)`, `.../fullscreencover(ispresented:ondismiss:content:)`, `.../confirmationdialog(_:ispresented:titlevisibility:actions:)`, `.../swipeactions(edge:allowsfullswipe:content:)`, `.../refreshable(action:)`, `.../redacted(reason:)`, `.../sensoryfeedback(_:trigger:)`, `.../submitlabel(_:)`, `.../contentshape(_:eofill:)`, `.../glasseffect(_:in:)`, `.../scrolledgeeffectstyle(_:for:)`, `.../tabbarminimizebehavior(_:)`, `swiftui/concentricrectangle`, `swiftui/viewthatfits`, `swiftui/vstack/init(alignment:spacing:content:)`, `swiftui/roundedcornerstyle/continuous`, `uikit/uifontmetrics`.

Standards: WCAG 2.2, W3C Recommendation 12 December 2024 <https://www.w3.org/TR/WCAG22/> (1.4.3, 1.4.4, 1.4.11, 2.2.1, 2.3.3, 2.5.1, 2.5.5, 2.5.7, 2.5.8 and the glossary). WCAG2ICT, W3C Group Note 11 December 2025 <https://www.w3.org/TR/wcag2ict-22/>.

Practitioners:

- NN/g: Skeleton Screens 101 (2023, reviewed 2026-09) <https://www.nngroup.com/articles/skeleton-screens/>; Response Time Limits <https://www.nngroup.com/articles/response-times-3-important-limits/>; Touch Targets on Touchscreens <https://www.nngroup.com/articles/touch-target-size/>; Using Swipe to Trigger Contextual Actions <https://www.nngroup.com/articles/contextual-swipe/>; Icon Usability <https://www.nngroup.com/articles/icon-usability/>; Indicators, Validations, and Notifications <https://www.nngroup.com/articles/indicators-validations-notifications/>; Typography for Glanceable Reading <https://www.nngroup.com/articles/glanceable-fonts/>; 113 Design Guidelines for Homepage Usability <https://www.nngroup.com/articles/113-design-guidelines-homepage-usability/>. Also read: progress indicators, progressive disclosure, flat UI signifiers, modal and nonmodal dialogs, bottom sheets, aesthetic and minimalist design.
- Luke Wroblewski: Touch Target Sizes (2010) <https://www.lukew.com/ff/entry.asp?1085>; Obvious Always Wins (2015) <https://www.lukew.com/ff/entry.asp?1945>.
- Bjango (Marc Edwards): Interaction density (2016) <https://bjango.com/articles/interactiondensity/>. Also read: Formulas for optical adjustments (2023).
- Lux (Sebastiaan de With): Physicality: the new age of UI (June 2025) <https://www.lux.camera/physicality-the-new-age-of-ui/>.

Repository: ADR-0039, ADR-0051 (with its amendments to October 29), ADR-0150, ADR-0151, `docs/plans/iphone-glow-look.md`, `apps/ios/README.md`, `apps/ios/Sotto/Design.swift`, `apps/ios/Sotto/Views.swift`, `apps/ios/Sotto/ThemePalettes.swift`, `CONTEXT.md`, the desktop rubric `docs/research/ui-good-practice.md`, and `~/ui-hillclimb/shared-notes.md`.
