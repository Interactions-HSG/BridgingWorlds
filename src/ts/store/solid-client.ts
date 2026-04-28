/**
 * Solid Pod HTTP client with Solid-OIDC authentication.
 *
 * Handles container creation, resource upload, and LDP operations.
 * Uses @inrupt/solid-client-authn-node for client credentials auth.
 */

import {
  Session,
  getSessionFromStorage,
} from "@inrupt/solid-client-authn-node";
import { SolidConfig } from "../config.js";

export class SolidClient {
  private session: Session | null = null;
  private config: SolidConfig;

  constructor(config: SolidConfig) {
    this.config = config;
  }

  async authenticate(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret) {
      console.warn(
        "No Solid credentials configured. Operating in unauthenticated mode."
      );
      return;
    }

    // openid-client's default 3.5s timeout is too tight for solidcommunity.net's
    // token endpoint on cold-start. Retry a few times before giving up.
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.session = new Session();
      try {
        await this.session.login({
          oidcIssuer: this.config.idp,
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
        });
        if (this.session.info.isLoggedIn) {
          console.log(`Authenticated as ${this.session.info.webId}`);
          return;
        }
        throw new Error("Solid-OIDC authentication failed (not logged in)");
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(msg);
        if (!transient || attempt === maxAttempts) break;
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  Auth attempt ${attempt} failed (${msg}); retrying in ${backoff}ms…`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private get fetch(): typeof globalThis.fetch {
    return this.session?.fetch ?? globalThis.fetch;
  }

  private resolveUrl(path: string): string {
    const base = this.config.podUrl.replace(/\/$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${base}${cleanPath}`;
  }

  /**
   * Create an LDP Basic Container.
   */
  async createContainer(path: string): Promise<boolean> {
    const url = this.resolveUrl(path);

    // Check if it already exists
    const head = await this.fetch(url, { method: "HEAD" });
    if (head.ok) return false; // already exists

    const parentUrl = url.replace(/\/[^/]+\/?$/, "/");
    const slug = path.replace(/\/$/, "").split("/").pop() || "";

    const response = await this.fetch(parentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/turtle",
        Slug: slug,
        Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: "",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to create container ${path}: ${response.status} ${response.statusText}`
      );
    }
    return true;
  }

  /**
   * Upload an RDF (Turtle) resource to the Pod.
   */
  async uploadTurtle(path: string, content: string): Promise<void> {
    const url = this.resolveUrl(path);
    const response = await this.fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/turtle",
      },
      body: content,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to upload ${path}: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Upload a binary resource (image/video) to the Pod.
   */
  async uploadBinary(
    path: string,
    content: Buffer,
    mimeType: string
  ): Promise<void> {
    const url = this.resolveUrl(path);
    const response = await this.fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
      },
      body: content as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to upload binary ${path}: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Read an RDF resource from the Pod as Turtle text.
   */
  async readResource(path: string): Promise<string> {
    const url = this.resolveUrl(path);
    const response = await this.fetch(url, {
      headers: { Accept: "text/turtle" },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to read ${path}: ${response.status} ${response.statusText}`
      );
    }
    return response.text();
  }

  /**
   * Read a binary resource from the Pod (image/video).
   * Returns the raw bytes and content type.
   */
  async readBinary(path: string): Promise<{ data: Buffer; contentType: string }> {
    const url = this.resolveUrl(path);
    const response = await this.fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to read binary ${path}: ${response.status} ${response.statusText}`
      );
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    return { data: Buffer.from(arrayBuffer), contentType };
  }

  /**
   * Get the full URL for a Pod path (for use in ActivityPub output etc.)
   */
  getPublicUrl(path: string): string {
    return this.resolveUrl(path);
  }

  /**
   * Delete a resource or empty container.
   * Returns false on 404 (already gone), true on 2xx. Throws on other errors.
   */
  async deleteResource(path: string): Promise<boolean> {
    const url = this.resolveUrl(path);
    const response = await this.fetch(url, { method: "DELETE" });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(
        `Failed to delete ${path}: ${response.status} ${response.statusText}`
      );
    }
    return true;
  }

  /**
   * Check if a resource exists.
   */
  async exists(path: string): Promise<boolean> {
    const url = this.resolveUrl(path);
    const response = await this.fetch(url, { method: "HEAD" });
    return response.ok;
  }

  async logout(): Promise<void> {
    if (this.session?.info.isLoggedIn) {
      await this.session.logout();
    }
  }
}
