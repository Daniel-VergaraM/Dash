// WebAuthn wire format: the API speaks ArrayBuffer, JSON speaks base64url.

export const b64uToBuf = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const bufToB64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Only the fields the server verifies; anything else the authenticator returns is noise.
export const credToJSON = (c: PublicKeyCredential) => {
  const response = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  return {
    id: c.id,
    rawId: bufToB64u(c.rawId),
    type: c.type,
    clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: bufToB64u(response.clientDataJSON),
      ...(response.attestationObject
        ? {
            attestationObject: bufToB64u(response.attestationObject),
            transports: response.getTransports?.() || [],
          }
        : {
            authenticatorData: bufToB64u(response.authenticatorData),
            signature: bufToB64u(response.signature),
            userHandle: response.userHandle ? bufToB64u(response.userHandle) : undefined,
          }),
    },
  };
};

export const hasWebAuthn = () => !!(window.PublicKeyCredential && navigator.credentials);
