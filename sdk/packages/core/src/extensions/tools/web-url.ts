import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

type Address = { address: string; family: number };

export function isPublicAddress(address: string): boolean {
	try {
		let parsed = ipaddr.parse(address);
		if (
			parsed.kind() === "ipv6" &&
			(parsed as ipaddr.IPv6).isIPv4MappedAddress()
		)
			parsed = (parsed as ipaddr.IPv6).toIPv4Address();
		return parsed.range() === "unicast";
	} catch {
		return false;
	}
}
export async function validateWebUrl(
	value: string,
	resolver: (host: string) => Promise<Address[]> = (host) =>
		lookup(host, { all: true }),
): Promise<{ url: URL; address: Address }> {
	if (
		value.length > 4096 ||
		Array.from(value).some((character) => character.charCodeAt(0) <= 0x20)
	)
		throw new Error("Invalid public URL");
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("Use a public HTTP(S) URL without credentials");
	const addresses = await resolver(url.hostname.replace(/^\[|\]$/g, ""));
	if (
		!addresses.length ||
		addresses.some(({ address }) => !isPublicAddress(address))
	)
		throw new Error(
			"Only public Internet addresses are allowed, including after redirects",
		);
	return { url, address: addresses.sort((a, b) => a.family - b.family)[0]! };
}
