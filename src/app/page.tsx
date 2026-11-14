import Link from "next/link";
import { RunConsole } from "@/components/RunConsole";

export default function Home() {
  return (
    <>
      <div className="max-w-3xl">
        <h1 className="text-4xl font-extrabold leading-[1.05] sm:text-5xl">Any agent can ask. Only the mandate can buy.</h1>
        <p className="mt-4 text-lg leading-relaxed text-soft">
          This is Valio Aimo&apos;s door for buying agents. A hotel chain gives its agent a mandate: how much it may spend, where it may deliver, what the
          food must be. The gateway checks every order against that mandate on Valio Aimo&apos;s side, signs every price it promises, and sends the
          exceptions to a human. Run it below, then try to break it.
        </p>
      </div>

      <div className="mt-8">
        <RunConsole />
      </div>

      <div className="mt-12 grid gap-x-10 gap-y-6 border-t border-line pt-8 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <h2 className="font-bold">Ask a real agent</h2>
          <p className="mt-1 text-soft">
            The runs above are scripted calls. On the next page a language model does the buying with the same six tools, and you can ask it to cheat.
          </p>
          <Link href="/agent" className="mt-2 inline-block font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
            Open the live agent
          </Link>
        </div>
        <div>
          <h2 className="font-bold">Be the purchaser</h2>
          <p className="mt-1 text-soft">
            The menu run leaves two lines waiting. Approve them, take one of the ranked options, or raise the order limit and watch the same request go
            through.
          </p>
          <Link href="/purchaser" className="mt-2 inline-block font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
            Open the purchaser&apos;s desk
          </Link>
        </div>
        <div>
          <h2 className="font-bold">Don&apos;t trust the gateway either</h2>
          <p className="mt-1 text-soft">
            Every offer is signed. Paste one, change a single character, and it fails. Your browser checks it with the public key, without asking us.
          </p>
          <Link href="/verify" className="mt-2 inline-block font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
            Verify an offer
          </Link>
        </div>
        <div>
          <h2 className="font-bold">Bring your own agent</h2>
          <p className="mt-1 text-soft">
            The same six tools are open over MCP and REST. Connect Claude Desktop or any other agent and ask it for 1,000 litres of lactose-free milk.
          </p>
          <Link href="/connect" className="mt-2 inline-block font-semibold text-teal underline underline-offset-2 hover:text-teal-deep">
            Connect an agent
          </Link>
        </div>
      </div>
    </>
  );
}
