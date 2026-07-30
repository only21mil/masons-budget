import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

interface RendererSecurityPolicy {
  readonly documentUrl: string
  allowsDocument(target: string): boolean
  allowsResource(target: string): boolean
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function parsedUrl(target: string): URL | null {
  try {
    return new URL(target)
  } catch {
    return null
  }
}

function devPolicy(rawUrl: string): RendererSecurityPolicy | null {
  const configured = parsedUrl(rawUrl)
  if (
    configured === null ||
    (configured.protocol !== "http:" && configured.protocol !== "https:") ||
    configured.username !== "" ||
    configured.password !== "" ||
    configured.hash !== ""
  ) {
    return null
  }

  const documentPath = configured.pathname
  const documentSearch = configured.search
  return {
    documentUrl: configured.href,
    allowsDocument(target) {
      const candidate = parsedUrl(target)
      return candidate !== null &&
        candidate.origin === configured.origin &&
        candidate.pathname === documentPath &&
        candidate.search === documentSearch
    },
    allowsResource(target) {
      const candidate = parsedUrl(target)
      if (candidate === null) return false
      if (candidate.origin === configured.origin) return true

      // Vite's development websocket is the only alternate protocol allowed.
      const websocketProtocol = configured.protocol === "https:" ? "wss:" : "ws:"
      return candidate.protocol === websocketProtocol &&
        candidate.hostname === configured.hostname &&
        candidate.port === configured.port &&
        candidate.username === "" &&
        candidate.password === ""
    },
  }
}

function packagedPolicy(rendererDist: string): RendererSecurityPolicy {
  const root = path.resolve(rendererDist)
  const indexPath = path.join(root, "index.html")
  const documentUrl = pathToFileURL(indexPath).href
  return {
    documentUrl,
    allowsDocument(target) {
      const candidate = parsedUrl(target)
      if (candidate === null || candidate.protocol !== "file:") return false
      try {
        return path.resolve(fileURLToPath(candidate)) === indexPath
      } catch {
        return false
      }
    },
    allowsResource(target) {
      const candidate = parsedUrl(target)
      if (candidate === null || candidate.protocol !== "file:") return false
      try {
        return isContainedPath(root, fileURLToPath(candidate))
      } catch {
        return false
      }
    },
  }
}

export function createRendererSecurityPolicy(
  rendererDist: string,
  devServerUrl?: string,
): RendererSecurityPolicy {
  if (devServerUrl !== undefined) {
    const policy = devPolicy(devServerUrl)
    if (policy !== null) return policy
    throw new Error("VITE_DEV_SERVER_URL is not a trusted renderer URL")
  }
  return packagedPolicy(rendererDist)
}
