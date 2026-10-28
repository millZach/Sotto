import XCTest

final class PhoneGlowTests: XCTestCase {
    func testTheStandardGlowIsTheLookAsDrawn() {
        let glow = PhoneGlow(PhoneGlow.standard)
        XCTAssertTrue(glow.shows)
        XCTAssertEqual(glow.radius(18), 18)
        XCTAssertEqual(glow.alpha(0.45), 0.45)
    }

    func testNoGlowDrawsNothing() {
        let glow = PhoneGlow(0)
        XCTAssertFalse(glow.shows)
        XCTAssertEqual(glow.radius(18), 0)
        XCTAssertEqual(glow.alpha(0.6), 0)
    }

    func testEveryStepIsBrighterThanTheOneBelow() {
        let factors = (0...100).map { PhoneGlow($0).factor }
        XCTAssertEqual(factors, factors.sorted())
        XCTAssertEqual(Set(factors).count, factors.count)
    }

    func testRadiusAndStrengthMoveTogether() {
        for level in stride(from: 5, through: 100, by: 5) {
            let glow = PhoneGlow(level)
            XCTAssertEqual(glow.radius(10) / 10, glow.alpha(0.2) / 0.2, accuracy: 1e-9, "level \(level)")
        }
        XCTAssertEqual(PhoneGlow(100).radius(18), 27)
        XCTAssertEqual(PhoneGlow(100).alpha(0.4), 0.6, accuracy: 1e-9)
        XCTAssertEqual(PhoneGlow(75).radius(16), 20)
        XCTAssertEqual(PhoneGlow(25).radius(12), 6)
    }

    func testStrengthNeverPassesSolidAndLevelsStayInRange() {
        XCTAssertEqual(PhoneGlow(100).alpha(0.8), 1)
        XCTAssertEqual(PhoneGlow(250).level, 100)
        XCTAssertEqual(PhoneGlow(-4).level, 0)
    }

    func testAMissingPreferenceReadsAsTheStandardGlow() {
        let defaults = UserDefaults(suiteName: "PhoneGlowTests")!
        defaults.removePersistentDomain(forName: "PhoneGlowTests")
        XCTAssertEqual(PhonePreferences(defaults: defaults).glow, PhoneGlow(PhoneGlow.standard))
        defaults.set(0, forKey: PhonePreferenceKey.glow)
        XCTAssertFalse(PhonePreferences(defaults: defaults).glow.shows)
        defaults.removePersistentDomain(forName: "PhoneGlowTests")
    }
}
