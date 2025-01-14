import { wallet } from "lib/blockchain/wallet";
import { CONFIG } from "lib/config";
import { ERRORS } from "lib/errors";
import { GoblinRetreatItemName, LimitedItemName } from "../types/craftables";

type Request = {
  farmId: number;
  sessionId: string;
  item: LimitedItemName | GoblinRetreatItemName;
  token: string;
  captcha: string;
  transactionId: string;
};

const API_URL = CONFIG.API_URL;

export async function mint(request: Request) {
  return mintCollectible(request);
}

async function mintCollectible(request: Request) {
  const response = await window.fetch(
    `${API_URL}/mint-collectible/${request.farmId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        Authorization: `Bearer ${request.token}`,
        "X-Transaction-ID": request.transactionId,
      },
      body: JSON.stringify({
        sessionId: request.sessionId,
        item: request.item,
        captcha: request.captcha,
      }),
    }
  );

  if (response.status === 429) {
    throw new Error(ERRORS.TOO_MANY_REQUESTS);
  }

  if (response.status !== 200 || !response.ok) {
    throw new Error(ERRORS.MINT_COLLECTIBLE_SERVER_ERROR);
  }

  const transaction = await response.json();

  const sessionId = await wallet
    .getSessionManager()
    .mintCollectible(transaction);

  return { sessionId, verified: true };
}
