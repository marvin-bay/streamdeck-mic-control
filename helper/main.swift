// mic-control-helper – native part of the Stream Deck plugin "Mic Control".
//
// Talks to the plugin over stdin/stdout, one JSON object per line.
//   Plugin → helper: {"cmd":"setDevice","uid":"…"}  (no uid/name = follow the system default input)
//                    {"cmd":"setLevel","value":0.42}, {"cmd":"getLevel"}, {"cmd":"listDevices"},
//                    {"cmd":"adjustStart"}, {"cmd":"adjustEnd"}, {"cmd":"checkAccess"}, {"cmd":"requestAccess"}
//   Helper → plugin: {"evt":"hello",…}, {"evt":"level","value":0.42}, {"evt":"device","connected":true,…},
//                    {"evt":"devices","list":[…]}, {"evt":"step","delta":1,"shift":false},
//                    {"evt":"access","trusted":true}, {"evt":"error","message":"…"}
//
// Command line for testing:  mic-control-helper --list         (print input devices with their level)
//                            mic-control-helper --no-disclaim  (don't start in an own TCC context)

import AppKit
import ApplicationServices
import CoreAudio
import Darwin
import Foundation

// MARK: - Constants

/// Trackpad: accumulated scroll points per 1 % step.
let pointsPerStep: Double = 12
let keyCodeUp: Int64 = 126
let keyCodeDown: Int64 = 125

// MARK: - Output

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    var out = data
    out.append(0x0A)
    FileHandle.standardOutput.write(out)
}

func emitError(_ message: String) {
    emit(["evt": "error", "message": message])
}

// MARK: - Own TCC context (Accessibility)
//
// Processes launched by Stream Deck inherit its TCC responsibility: without countermeasures the user
// would have to grant Accessibility to the whole Stream Deck app. We therefore relaunch ourselves once
// with `responsibility_spawnattrs_setdisclaim`, so macOS checks the permission for this binary only.

var childPid: pid_t = 0

func spawnDisclaimed() -> pid_t? {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
        return nil
    }
    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    let setDisclaim = unsafeBitCast(sym, to: SetDisclaim.self)

    var attr: posix_spawnattr_t? = nil
    guard posix_spawnattr_init(&attr) == 0 else { return nil }
    defer { posix_spawnattr_destroy(&attr) }
    guard setDisclaim(&attr, 1) == 0 else { return nil }

    guard let exe = Bundle.main.executablePath else { return nil }
    let args = [exe] + CommandLine.arguments.dropFirst() + ["--disclaimed"]
    var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
    cargs.append(nil)
    defer { cargs.forEach { free($0) } }

    var pid: pid_t = 0
    let rc = posix_spawn(&pid, exe, nil, &attr, cargs, environ)
    return rc == 0 ? pid : nil
}

/// Starts the child without the parent's responsibility, forwards signals and exits with it.
func superviseDisclaimedChild() {
    let args = CommandLine.arguments
    guard !args.contains("--disclaimed"), !args.contains("--no-disclaim"), !args.contains("--list") else { return }
    guard let pid = spawnDisclaimed() else { return } // fallback: keep running in this process
    childPid = pid
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { s in
            if childPid > 0 { kill(childPid, s) }
        }
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    let exited = (status & 0x7f) == 0
    exit(exited ? (status >> 8) & 0xff : 1)
}

// MARK: - Core Audio

func addr(_ sel: AudioObjectPropertySelector,
          _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
          _ el: UInt32 = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: el)
}

func cfStringProperty(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = addr(sel)
    var cf: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &cf) == noErr, let s = cf?.takeRetainedValue() else {
        return nil
    }
    return s as String
}

func allDeviceIDs() -> [AudioDeviceID] {
    var a = addr(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    let sys = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func defaultInputDeviceID() -> AudioDeviceID? {
    var a = addr(kAudioHardwarePropertyDefaultInputDevice)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id) == noErr,
          id != kAudioObjectUnknown else { return nil }
    return id
}

func inputChannelCount(_ id: AudioDeviceID) -> Int {
    var a = addr(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

/// Elements 0…2 that have an input volume (0 = main).
func volumeElements(_ id: AudioDeviceID) -> [UInt32] {
    (UInt32(0)...2).filter { el in
        var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, el)
        return AudioObjectHasProperty(id, &a)
    }
}

func isVolumeSettable(_ id: AudioDeviceID, _ els: [UInt32]) -> Bool {
    els.contains { el in
        var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, el)
        var settable: DarwinBoolean = false
        return AudioObjectIsPropertySettable(id, &a, &settable) == noErr && settable.boolValue
    }
}

struct InputDevice {
    let id: AudioDeviceID
    let uid: String
    let name: String
}

func inputDevice(_ id: AudioDeviceID) -> InputDevice? {
    guard inputChannelCount(id) > 0,
          let uid = cfStringProperty(id, kAudioDevicePropertyDeviceUID),
          let name = cfStringProperty(id, kAudioObjectPropertyName) else { return nil }
    return InputDevice(id: id, uid: uid, name: name)
}

func inputDevices() -> [InputDevice] {
    allDeviceIDs().compactMap(inputDevice)
}

func rounded(_ v: Float32) -> Double {
    (Double(v) * 10000).rounded() / 10000
}

final class AudioController {
    /// Target: a specific UID, else a name, else the system default input.
    var wantUID: String?
    var wantName: String?

    private(set) var device: InputDevice?
    private var readElements: [UInt32] = []
    private var writeElements: [UInt32] = []
    private var listeners: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private var lastSent: Double?
    private var hasResolved = false

    init() {
        let sys = AudioObjectID(kAudioObjectSystemObject)
        for sel in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
            var a = addr(sel)
            AudioObjectAddPropertyListenerBlock(sys, &a, DispatchQueue.main) { [weak self] _, _ in
                self?.resolve()
            }
        }
    }

    private func find() -> InputDevice? {
        if let uid = wantUID { return inputDevices().first { $0.uid == uid } }
        if let name = wantName { return inputDevices().first { $0.name == name } }
        return defaultInputDeviceID().flatMap(inputDevice)
    }

    /// (Re)resolve the target device; reports plug/unplug and registers the level listeners.
    func resolve(force: Bool = false) {
        let found = find()
        if !force, hasResolved, found?.id == device?.id { return }
        hasResolved = true
        detach()
        device = found
        lastSent = nil
        guard let dev = found else {
            emit(["evt": "device", "connected": false])
            return
        }
        let els = volumeElements(dev.id)
        writeElements = els
        readElements = els.contains(0) ? [0] : els
        attach(dev.id)
        emit([
            "evt": "device", "connected": true, "uid": dev.uid, "name": dev.name,
            "adjustable": isVolumeSettable(dev.id, els), "followsDefault": wantUID == nil && wantName == nil,
        ])
        emitLevel(force: true)
    }

    private func attach(_ id: AudioDeviceID) {
        for el in readElements {
            var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, el)
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.emitLevel() }
            if AudioObjectAddPropertyListenerBlock(id, &a, DispatchQueue.main, block) == noErr {
                listeners.append((a, block))
            }
        }
    }

    private func detach() {
        guard let id = device?.id else { listeners.removeAll(); return }
        for (address, block) in listeners {
            var a = address
            AudioObjectRemovePropertyListenerBlock(id, &a, DispatchQueue.main, block) // fails harmlessly if unplugged
        }
        listeners.removeAll()
    }

    func readLevel() -> Float32? {
        guard let id = device?.id, !readElements.isEmpty else { return nil }
        var sum: Float32 = 0
        var n = 0
        for el in readElements {
            var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, el)
            var v: Float32 = 0
            var size = UInt32(MemoryLayout<Float32>.size)
            if AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v) == noErr {
                sum += v
                n += 1
            }
        }
        return n > 0 ? sum / Float32(n) : nil
    }

    func emitLevel(force: Bool = false) {
        guard device != nil else { return }
        guard let v = readLevel() else {
            if force { emit(["evt": "level", "value": NSNull()]) }
            return
        }
        let r = rounded(v)
        if !force, r == lastSent { return }
        lastSent = r
        emit(["evt": "level", "value": r])
    }

    func setLevel(_ value: Double) {
        guard let id = device?.id else { emitError("setLevel: device not connected"); return }
        var v = Float32(min(1, max(0, value)))
        for el in writeElements {
            var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, el)
            let status = AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
            if status != noErr { emitError("setLevel: element \(el) OSStatus \(status)") }
        }
    }

    func deviceList() -> [[String: Any]] {
        let defaultID = defaultInputDeviceID()
        return inputDevices().map { dev in
            let els = volumeElements(dev.id)
            return ["uid": dev.uid, "name": dev.name, "adjustable": isVolumeSettable(dev.id, els),
                    "isDefault": dev.id == defaultID]
        }
    }
}

// MARK: - Event tap (arrow keys + scrolling, only while the Stream Deck key is held)

final class Adjuster {
    private var tap: CFMachPort?
    private(set) var active = false
    private var accum: Double = 0

    func start() {
        guard AXIsProcessTrusted() else {
            emit(["evt": "access", "trusted": false, "context": "adjust"])
            return
        }
        if tap == nil {
            let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
                | (1 << CGEventType.scrollWheel.rawValue)
            guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                            eventsOfInterest: CGEventMask(mask), callback: tapCallback, userInfo: nil)
            else {
                emit(["evt": "access", "trusted": false, "context": "adjust"])
                return
            }
            tap = t
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        }
        accum = 0
        active = true
        CGEvent.tapEnable(tap: tap!, enable: true)
    }

    func stop() {
        active = false
        accum = 0
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
    }

    func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if active, let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard active else { return Unmanaged.passUnretained(event) }
        let shift = event.flags.contains(.maskShift)

        switch type {
        case .keyDown, .keyUp:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            guard code == keyCodeUp || code == keyCodeDown else { return Unmanaged.passUnretained(event) }
            if type == .keyDown { // includes key repeat
                emit(["evt": "step", "delta": code == keyCodeUp ? 1 : -1, "shift": shift])
            }
            return nil // consumed

        case .scrollWheel:
            // Normalise to the physical direction: up / away from the user = louder,
            // regardless of "natural scrolling".
            let inverted = NSEvent(cgEvent: event)?.isDirectionInvertedFromDevice ?? false
            let sign: Double = inverted ? -1 : 1
            if event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0 {
                accum += sign * event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
                let steps = Int(accum / pointsPerStep) // truncated towards zero
                if steps != 0 {
                    accum -= Double(steps) * pointsPerStep
                    emit(["evt": "step", "delta": steps, "shift": shift])
                }
            } else {
                var d = Double(event.getIntegerValueField(.scrollWheelEventDeltaAxis1))
                if d == 0 { d = event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1) }
                d *= sign
                if d != 0 { emit(["evt": "step", "delta": d > 0 ? 1 : -1, "shift": shift]) } // 1 % per notch
            }
            return nil // consumed

        default:
            return Unmanaged.passUnretained(event)
        }
    }
}

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    adjuster.handle(type, event)
}

// MARK: - Accessibility status

var lastTrusted: Bool?

func emitAccess(force: Bool = false) {
    let trusted = AXIsProcessTrusted()
    if !force, trusted == lastTrusted { return }
    lastTrusted = trusted
    emit(["evt": "access", "trusted": trusted])
}

// MARK: - Commands

func handle(_ line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    guard let data = trimmed.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let cmd = obj["cmd"] as? String else {
        emitError("invalid message: \(trimmed)")
        return
    }
    switch cmd {
    case "setDevice":
        audio.wantUID = (obj["uid"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        audio.wantName = (obj["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        audio.resolve(force: true)
    case "setLevel":
        guard let v = (obj["value"] as? NSNumber)?.doubleValue else { emitError("setLevel without value"); return }
        audio.setLevel(v)
    case "getLevel":
        audio.emitLevel(force: true)
    case "listDevices":
        emit(["evt": "devices", "list": audio.deviceList()])
    case "adjustStart":
        adjuster.start()
    case "adjustEnd":
        adjuster.stop()
    case "checkAccess":
        emitAccess(force: true)
    case "requestAccess":
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        emitAccess(force: true)
    case "quit":
        exit(0)
    default:
        emitError("unknown command: \(cmd)")
    }
}

// MARK: - Start

if CommandLine.arguments.contains("--list") {
    let defaultID = defaultInputDeviceID()
    for dev in inputDevices() {
        let els = volumeElements(dev.id)
        var level = "–"
        if let el = els.first {
            var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, el)
            var v: Float32 = 0
            var size = UInt32(MemoryLayout<Float32>.size)
            if AudioObjectGetPropertyData(dev.id, &a, 0, nil, &size, &v) == noErr { level = "\(Int((v * 100).rounded())) %" }
        }
        let mark = dev.id == defaultID ? "*" : " "
        print("\(mark) \(dev.name)\t\(dev.uid)\telements \(els)\tlevel \(level)\tsettable \(isVolumeSettable(dev.id, els))")
    }
    print("(* = system default input)  Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted")")
    exit(0)
}

superviseDisclaimedChild()

signal(SIGPIPE, SIG_IGN)
let audio = AudioController()
let adjuster = Adjuster()

emit(["evt": "hello", "version": 1, "pid": Int(getpid()),
      "disclaimed": CommandLine.arguments.contains("--disclaimed")])
emitAccess(force: true)

// Notice permission changes (System Settings → Accessibility) without polling.
DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.accessibility.api"),
                                                    object: nil, queue: .main) { _ in
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { emitAccess() }
}

// Read stdin on a separate thread, run commands on the main run loop. EOF = plugin gone → exit.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        DispatchQueue.main.async { handle(line) }
    }
    DispatchQueue.main.async { exit(0) }
}

CFRunLoopRun()
