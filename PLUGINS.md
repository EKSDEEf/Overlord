# Overlord Plugins

This document explains how to build Overlord plugins using the **native plugin system**. Plugins run as native shared libraries (`.so` on Linux, `.dylib` on macOS, in-memory DLL on Windows), giving them full access to the Go runtime and system APIs.

> TL;DR: A plugin is a zip with platform-specific binaries (`.so`/`.dll`/`.dylib`) plus `<id>.html`, `<id>.css`, `<id>.js`. Upload it in the Plugins page or drop it in Overlord-Server/plugins.

## 1) How plugins are structured

### Required bundle format

A plugin bundle is a zip file named after the plugin ID:

```
<pluginId>.zip
```

Inside the zip (root level), you need:

- **Platform-specific binaries** named `<pluginId>-<os>-<arch>.<ext>`
- **Web assets**: `<pluginId>.html`, `<pluginId>.css`, `<pluginId>.js`

Example for plugin ID `sample`:

```
sample.zip
  ├─ sample-linux-amd64.so
  ├─ sample-linux-arm64.so
  ├─ sample-darwin-arm64.dylib
  ├─ sample-windows-amd64.dll
  ├─ sample.html
  ├─ sample.css
  └─ sample.js
```

When the server extracts the zip:

```
Overlord-Server/plugins/sample/
  ├─ sample-linux-amd64.so
  ├─ sample-linux-arm64.so
  ├─ sample-darwin-arm64.dylib
  ├─ sample-windows-amd64.dll
  ├─ manifest.json          (auto-generated)
  └─ assets/
     ├─ sample.html
     ├─ sample.css
     └─ sample.js
```

### Manifest fields

The auto-generated manifest:

```json
{
  "id": "sample",
  "name": "sample",
  "version": "1.0.0",
  "binaries": {
    "linux-amd64": "sample-linux-amd64.so",
    "linux-arm64": "sample-linux-arm64.so",
    "darwin-arm64": "sample-darwin-arm64.dylib",
    "windows-amd64": "sample-windows-amd64.dll"
  },
  "entry": "sample.html",
  "assets": {
    "html": "sample.html",
    "css": "sample.css",
    "js": "sample.js"
  }
}
```

The server picks the right binary for the target client's OS/arch when loading.

## 2) Build a native plugin

### Plugin contract

Plugins are Go packages that export specific functions. The core logic is shared across platforms, with thin platform-specific export wrappers.

All platforms use `-buildmode=c-shared` and export C-callable functions.

#### Linux / macOS (`.so` / `.dylib`)

```go
//export PluginOnLoad
func PluginOnLoad(hostInfo *C.char, hostInfoLen C.int, cb C.uintptr_t, ctx C.uintptr_t) C.int

//export PluginOnEvent
func PluginOnEvent(event *C.char, eventLen C.int, payload *C.char, payloadLen C.int) C.int

//export PluginOnUnload
func PluginOnUnload()
```

The host passes a callback function pointer and context during OnLoad. The plugin calls the callback to send events back.

Build: `CGO_ENABLED=1 go build -buildmode=c-shared -o sample-linux-amd64.so ./native`

**On Linux, shared libraries are loaded entirely in memory via `memfd_create` — no files touch disk.**

#### Windows (`.dll`)

```go
//export PluginOnLoad
func PluginOnLoad(hostInfo *C.char, hostInfoLen C.int, callbackPtr C.ulonglong) C.int

//export PluginOnEvent
func PluginOnEvent(event *C.char, eventLen C.int, payload *C.char, payloadLen C.int) C.int

//export PluginOnUnload
func PluginOnUnload()

//export PluginSetCallback
func PluginSetCallback(callbackPtr C.ulonglong)
```

The callback is a stdcall function pointer: `func(eventPtr, eventLen, payloadPtr, payloadLen uintptr) uintptr`

Build: `CGO_ENABLED=1 GOOS=windows GOARCH=amd64 go build -buildmode=c-shared -o sample-windows-amd64.dll ./native`

**On Windows, DLLs are loaded entirely in memory — no files are written to disk.**

### HostInfo JSON

```json
{
  "clientId": "abc123",
  "os": "windows",
  "arch": "amd64",
  "version": "1.0.0"
}
```

### Project structure

See `plugin-sample-go/native/` for a working example:

```
plugin-sample-go/native/
  ├─ main.go              (shared core logic)
  ├─ exports_unix.go      (Go plugin exports for Linux/macOS)
  ├─ exports_windows.go   (C-shared DLL exports for Windows)
  └─ go.mod
```

### Build scripts

Use the provided build scripts:

```bash
# Linux/macOS — builds for current platform by default
./build-plugin.sh

# Build for multiple targets
BUILD_TARGETS="linux-amd64 linux-arm64 darwin-arm64" ./build-plugin.sh

# Windows — builds windows-amd64 by default
build-plugin.bat

# Build for multiple targets
set BUILD_TARGETS=windows-amd64 linux-amd64
build-plugin.bat
```

## 3) Install & open a plugin

### Install / upload

- Use the UI at `/plugins` to upload the zip
- Or drop `<pluginId>.zip` into `Overlord-Server/plugins` and restart

### Open the UI

Plugin UI is served from:

```
/plugins/<pluginId>?clientId=<CLIENT_ID>
```

Your HTML loads its JS/CSS from `/plugins/<pluginId>/assets/`.

## 4) Runtime: how events flow

Overlord plugins have **two parts**:

1. **UI (HTML/CSS/JS)** — Runs in the browser, calls server APIs.
2. **Native module** — Runs in the agent (client) process as a loaded shared library.

### UI → agent (plugin event)

From your UI JS:

```
POST /api/clients/<clientId>/plugins/<pluginId>/event
{
  "event": "ui_message",
  "payload": { "message": "hello" }
}
```

If the plugin is not loaded yet, the server will load it on the client, queue the event, and deliver it once ready.

### Agent → plugin (direct function call)

The agent calls your `OnEvent(event, payload)` function directly with JSON-encoded data. No stdin/stdout pipes, no msgpack — just a direct function call.

### Plugin → agent (callback)

Your plugin sends events back to the host using the `send` callback received during `OnLoad`:

```go
send("echo", []byte(`{"message":"hello back"}`))
```

On Windows, the equivalent is calling the registered callback function pointer.

### Plugin lifecycle events

The agent sends these events to the server:

- `loaded` on successful load
- `unloaded` when unloaded
- `error` if load or runtime fails

## 5) What can plugins do?

Since plugins run as native code, they can:

- Call any system API (file I/O, network, processes, etc.)
- Use any Go library
- Spawn goroutines
- Access hardware
- Do anything a normal Go program can do

Plugins have the same capabilities as the agent itself.

### UI Security constraints

Plugin UI pages are still served with a tight CSP:

- Scripts must be same-origin
- No third-party JS/CDN
- WebSocket and fetch are allowed to same origin

Plugin UIs run in a **sandboxed iframe** with a fetch bridge.

## 6) API surface

### Plugin management

- `GET /api/plugins` — list installed plugins
- `POST /api/plugins/upload` — upload zip
- `POST /api/plugins/<id>/enable` — enable/disable
- `DELETE /api/plugins/<id>` — remove

### Per-client plugin runtime

- `POST /api/clients/<clientId>/plugins/<pluginId>/load`
- `POST /api/clients/<clientId>/plugins/<pluginId>/event`
- `POST /api/clients/<clientId>/plugins/<pluginId>/unload`

### Useful built-in endpoints

- `POST /api/clients/<clientId>/command`
- `WS /api/clients/<clientId>/rd/ws` (remote desktop)
- `WS /api/clients/<clientId>/console/ws`
- `WS /api/clients/<clientId>/files/ws`
- `WS /api/clients/<clientId>/processes/ws`


