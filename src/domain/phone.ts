export type Phone = string & { readonly __brand: "Phone" };

export function parsePhoneNumber(
  phoneNumber: unknown,
): { ok: true; value: Phone } | { ok: false } {
  if (typeof phoneNumber != "string") {
    return {
      ok: false,
    };
  }
  // accepts 10 digits, returns +91 form
  if (!/^[6-9][0-9]{9}$/.test(phoneNumber)) {
    return {
      ok: false,
    };
  } else {
    return {
      ok: true,
      value: (`+91` + phoneNumber) as Phone,
    };
  }
}
