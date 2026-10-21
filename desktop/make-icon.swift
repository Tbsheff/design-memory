import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

func squircle(_ rect: CGRect, exponent: CGFloat = 5) -> CGPath {
  let path = CGMutablePath()
  let a = rect.width / 2, b = rect.height / 2
  let steps = 720
  for step in 0...steps {
    let t = CGFloat(step) / CGFloat(steps) * 2 * .pi
    let c = cos(t), s = sin(t)
    let x = pow(abs(c), 2 / exponent) * a * (c < 0 ? -1 : 1)
    let y = pow(abs(s), 2 / exponent) * b * (s < 0 ? -1 : 1)
    let point = CGPoint(x: rect.midX + x, y: rect.midY + y)
    step == 0 ? path.move(to: point) : path.addLine(to: point)
  }
  path.closeSubpath()
  return path
}

func roundedCard(_ rect: CGRect, radius: CGFloat, rotation: CGFloat) -> CGPath {
  var transform = CGAffineTransform(translationX: rect.midX, y: rect.midY).rotated(by: rotation).translatedBy(x: -rect.midX, y: -rect.midY)
  return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: &transform)
}

func drawLinearGradient(_ context: CGContext, clip: CGPath, colors: [CGColor], from: CGPoint, to: CGPoint) {
  context.saveGState()
  context.addPath(clip)
  context.clip()
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
  context.drawLinearGradient(gradient, start: from, end: to, options: [])
  context.restoreGState()
}

func asterisk(center: CGPoint, length: CGFloat, thickness: CGFloat) -> CGPath {
  let path = CGMutablePath()
  for index in 0..<4 {
    let angle = CGFloat(index) * .pi / 4 + .pi / 2
    let transform = CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle)
    let bar = CGRect(x: -length / 2, y: -thickness / 2, width: length, height: thickness)
    path.addPath(CGPath(roundedRect: bar, cornerWidth: thickness / 2, cornerHeight: thickness / 2, transform: nil), transform: transform)
  }
  return path
}

func drawIcon(_ context: CGContext) {
  let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
  let tilePath = squircle(tile)

  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -10), blur: 22, color: rgb(0x0b1a10, 0.35))
  context.addPath(tilePath)
  context.setFillColor(rgb(0x2f5140))
  context.fillPath()
  context.restoreGState()

  drawLinearGradient(context, clip: tilePath, colors: [rgb(0x5a8c6c), rgb(0x2c4c3b)], from: CGPoint(x: 512, y: 924), to: CGPoint(x: 512, y: 100))

  context.saveGState()
  context.addPath(tilePath)
  context.clip()
  let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0xffffff, 0.18), rgb(0xffffff, 0)] as CFArray, locations: [0, 1])!
  context.drawRadialGradient(glow, startCenter: CGPoint(x: 380, y: 860), startRadius: 0, endCenter: CGPoint(x: 380, y: 860), endRadius: 560, options: [])
  context.restoreGState()

  let back = roundedCard(CGRect(x: 268, y: 300, width: 470, height: 520), radius: 54, rotation: 0.16)
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -8), blur: 24, color: rgb(0x0b1a10, 0.28))
  context.addPath(back)
  context.setFillColor(rgb(0xf3d8c8))
  context.fillPath()
  context.restoreGState()

  let front = roundedCard(CGRect(x: 292, y: 232, width: 470, height: 540), radius: 56, rotation: -0.07)
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -14), blur: 34, color: rgb(0x0b1a10, 0.38))
  context.addPath(front)
  context.setFillColor(rgb(0xfbfcf8))
  context.fillPath()
  context.restoreGState()
  drawLinearGradient(context, clip: front, colors: [rgb(0xffffff), rgb(0xeef3ec)], from: CGPoint(x: 527, y: 772), to: CGPoint(x: 527, y: 232))

  context.saveGState()
  context.translateBy(x: 527, y: 502)
  context.rotate(by: -0.07)

  let photo = CGRect(x: -205, y: -40, width: 410, height: 282)
  let photoPath = CGPath(roundedRect: photo, cornerWidth: 34, cornerHeight: 34, transform: nil)
  drawLinearGradient(context, clip: photoPath, colors: [rgb(0xf6c58f), rgb(0xf09a7a), rgb(0xd9737a)], from: CGPoint(x: 0, y: photo.maxY), to: CGPoint(x: 0, y: photo.minY))
  context.saveGState()
  context.addPath(photoPath)
  context.clip()
  let halo = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0xfff4dc, 0.85), rgb(0xfff4dc, 0)] as CFArray, locations: [0, 1])!
  context.drawRadialGradient(halo, startCenter: CGPoint(x: 82, y: 150), startRadius: 0, endCenter: CGPoint(x: 82, y: 150), endRadius: 120, options: [])
  let far = CGMutablePath()
  far.move(to: CGPoint(x: photo.minX, y: 40))
  far.addCurve(to: CGPoint(x: photo.maxX, y: 60), control1: CGPoint(x: -60, y: 150), control2: CGPoint(x: 80, y: -10))
  far.addLine(to: CGPoint(x: photo.maxX, y: photo.minY))
  far.addLine(to: CGPoint(x: photo.minX, y: photo.minY))
  far.closeSubpath()
  context.addPath(far)
  context.setFillColor(rgb(0x7fa88a, 0.95))
  context.fillPath()
  let near = CGMutablePath()
  near.move(to: CGPoint(x: photo.minX, y: -10))
  near.addCurve(to: CGPoint(x: photo.maxX, y: 20), control1: CGPoint(x: -20, y: 70), control2: CGPoint(x: 120, y: -60))
  near.addLine(to: CGPoint(x: photo.maxX, y: photo.minY))
  near.addLine(to: CGPoint(x: photo.minX, y: photo.minY))
  near.closeSubpath()
  context.addPath(near)
  context.setFillColor(rgb(0x385d49))
  context.fillPath()
  context.restoreGState()

  let mark = asterisk(center: CGPoint(x: 82, y: 150), length: 128, thickness: 19)
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -3), blur: 8, color: rgb(0x7a3b2e, 0.35))
  context.addPath(mark)
  context.setFillColor(rgb(0xffffff))
  context.fillPath()
  context.restoreGState()

  let swatches: [UInt32] = [0x385d49, 0xe8836b, 0xf1c25f]
  for (index, color) in swatches.enumerated() {
    let dot = CGRect(x: -205 + CGFloat(index) * 74, y: -168, width: 56, height: 56)
    context.setFillColor(rgb(color))
    context.fillEllipse(in: dot)
    context.setStrokeColor(rgb(0xffffff, 0.9))
    context.setLineWidth(5)
    context.strokeEllipse(in: dot.insetBy(dx: 2.5, dy: 2.5))
  }
  context.setFillColor(rgb(0xdfe7df))
  context.addPath(CGPath(roundedRect: CGRect(x: 30, y: -128, width: 175, height: 22), cornerWidth: 11, cornerHeight: 11, transform: nil))
  context.fillPath()
  context.addPath(CGPath(roundedRect: CGRect(x: 30, y: -170, width: 120, height: 22), cornerWidth: 11, cornerHeight: 11, transform: nil))
  context.fillPath()
  context.restoreGState()
}

func render(pixels: Int) -> Data {
  let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
  NSGraphicsContext.current = graphics
  let context = graphics.cgContext
  context.setShouldAntialias(true)
  context.interpolationQuality = .high
  context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
  drawIcon(context)
  NSGraphicsContext.restoreGraphicsState()
  return bitmap.representation(using: .png, properties: [:])!
}

for points in [16, 32, 128, 256, 512] {
  try render(pixels: points).write(to: output.appendingPathComponent("icon_\(points)x\(points).png"))
  try render(pixels: points * 2).write(to: output.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
