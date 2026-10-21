import AppKit
import WebKit

struct Config {
  let bun: String
  let main: String
  let root: String
  let port: Int

  var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

  static func load() -> Config {
    let info = Bundle.main.infoDictionary ?? [:]
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let root = ProcessInfo.processInfo.environment["DESIGN_MEMORY_HOME"] ?? info["TasteRoot"] as? String ?? "\(home)/.design-memory"
    return Config(
      bun: info["TasteBun"] as? String ?? "\(home)/.bun/bin/bun",
      main: info["TasteMain"] as? String ?? "\(home)/.agents/skills/design-memory/src/main.ts",
      root: root,
      port: servicePort(root: root) ?? 4781
    )
  }

  private static func servicePort(root: String) -> Int? {
    guard let data = FileManager.default.contents(atPath: "\(root)/service.json"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return json["port"] as? Int
  }
}

let clipboardBridge = """
(() => {
  const post = text => window.webkit.messageHandlers.tasteCopy.postMessage(String(text));
  const clipboard = navigator.clipboard ?? {};
  clipboard.writeText = text => { post(text); return Promise.resolve(); };
  if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { value: clipboard });
})();
"""

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  private let config = Config.load()
  private var window: NSWindow!
  private var webView: WKWebView!
  private var ownedServer: Process?
  private var reconnecting = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    buildWindow()
    Task { await connect() }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    ownedServer?.terminate()
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    window.orderOut(nil)
    return false
  }

  private func buildWindow() {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(self, name: "tasteCopy")
    configuration.userContentController.addUserScript(WKUserScript(source: clipboardBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsMagnification = true

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Taste"
    window.minSize = NSSize(width: 720, height: 520)
    window.contentView = webView
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("TasteMainWindow")
    window.makeKeyAndOrderFront(nil)
    showMessage("Starting Taste…")
  }

  private func buildMenu() {
    let main = NSMenu()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Taste", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Taste", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "Quit Taste", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    addSubmenu(appMenu, title: "Taste", to: main)

    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    addSubmenu(edit, title: "Edit", to: main)

    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "B")
    view.addItem(.separator())
    view.addItem(withTitle: "Actual Size", action: #selector(actualSize), keyEquivalent: "0")
    view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
    view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
    addSubmenu(view, title: "View", to: main)

    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    addSubmenu(windowMenu, title: "Window", to: main)
    NSApp.windowsMenu = windowMenu
    NSApp.mainMenu = main
  }

  private func addSubmenu(_ menu: NSMenu, title: String, to main: NSMenu) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.submenu = menu
    main.addItem(item)
  }

  @objc private func reload() { Task { await connect() } }
  @objc private func openInBrowser() { NSWorkspace.shared.open(config.base) }
  @objc private func actualSize() { webView.magnification = 1 }
  @objc private func zoomIn() { webView.magnification = min(webView.magnification + 0.1, 2) }
  @objc private func zoomOut() { webView.magnification = max(webView.magnification - 0.1, 0.6) }

  private func isUp() async -> Bool {
    var request = URLRequest(url: config.base.appendingPathComponent("api/stats"))
    request.timeoutInterval = 1.5
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  private func startOwnedServer() {
    guard ownedServer?.isRunning != true else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: config.bun)
    process.arguments = [config.main, "--root", config.root, "open", "--port", String(config.port), "--browser", "no"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do { try process.run(); ownedServer = process } catch { ownedServer = nil }
  }

  @MainActor private func connect() async {
    if !(await isUp()) {
      startOwnedServer()
      for _ in 0..<40 where !(await isUp()) { try? await Task.sleep(nanoseconds: 250_000_000) }
    }
    if await isUp() {
      webView.load(URLRequest(url: config.base))
    } else {
      showMessage("Taste could not start. Run `taste service status` in Terminal, then press ⌘R.")
    }
  }

  private func showMessage(_ text: String) {
    let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    webView.loadHTMLString("""
      <html><body style="font:15px -apple-system;color:#5b6b5e;background:#f7f8f6;display:grid;place-items:center;height:100vh;margin:0">
      <p>\(escaped)</p></body></html>
      """, baseURL: nil)
  }

  private func isWorkspace(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.host == "127.0.0.1" && url.port == config.port
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    if isWorkspace(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url {
      if isWorkspace(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard isWorkspace(webView.url), let target = ProcessInfo.processInfo.environment["TASTE_APP_SNAPSHOT"] else { return }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard let image = try? await webView.takeSnapshot(configuration: nil),
            let tiff = image.tiffRepresentation,
            let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
      try? png.write(to: URL(fileURLWithPath: target))
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    scheduleReconnect()
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    scheduleReconnect()
  }

  private func scheduleReconnect() {
    guard !reconnecting else { return }
    reconnecting = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      await connect()
      reconnecting = false
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "tasteCopy", let text = message.body as? String else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
