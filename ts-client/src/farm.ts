import { BN, EventParser } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Cluster,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { FarmProgram, Opt, PoolState, UserState } from "./types";
import {
  FARM_PROGRAM_ID,
  SIMULATION_USER,
  chunks,
  getFarmProgram,
  getOrCreateATAInstruction,
  parseLogs,
} from "./utils";

const chunkedFetchMultipleUserAccount = async (
  program: FarmProgram,
  pks: PublicKey[],
  chunkSize: number = 100
) => {
  const accounts = (
    await Promise.all(
      chunks(pks, chunkSize).map((chunk) =>
        program.account.user.fetchMultiple(chunk)
      )
    )
  ).flat();

  return accounts.filter(Boolean);
};

const chunkedFetchMultiplePoolAccount = async (
  program: FarmProgram,
  pks: PublicKey[],
  chunkSize: number = 100
) => {
  const accounts = (
    await Promise.all(
      chunks(pks, chunkSize).map((chunk) =>
        program.account.pool.fetchMultiple(chunk)
      )
    )
  ).flat();

  return accounts.filter(Boolean);
};

const getAllPoolState = async (
  farmMints: Array<PublicKey>,
  program: FarmProgram
) => {
  const poolStates = (await chunkedFetchMultiplePoolAccount(
    program,
    farmMints
  )) as Array<PoolState>;

  return poolStates;
};

const MAX_CLAIM_ALL_ALLOWED = 2;

export class PoolFarmImpl {
  private opt: Opt = {
    cluster: "mainnet-beta",
  };

  private constructor(
    public address: PublicKey,
    private program: FarmProgram,
    private eventParser: EventParser,
    public poolState: PoolState,
    opt: Opt
  ) {
    this.opt = opt;
  }

  public static async createMultiple(
    connection: Connection,
    farmList: Array<PublicKey>,
    opt?: {
      cluster?: Cluster;
    }
  ) {
    const cluster = opt?.cluster ?? "mainnet-beta";
    const { program } = getFarmProgram(connection);
    const eventParser = new EventParser(FARM_PROGRAM_ID, program.coder);

    const poolsState = await getAllPoolState(farmList, program);

    return poolsState.map((poolState, idx) => {
      const address = farmList[idx];
      return new PoolFarmImpl(address, program, eventParser, poolState, {
        cluster,
      });
    });
  }

  public static async getUserBalances(
    connection: Connection,
    owner: PublicKey,
    farmMints: Array<PublicKey>
  ) {
    const { program } = getFarmProgram(connection);

    const userStakingPda = farmMints.map((mint) => {
      const [userStakingAddress] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), mint.toBuffer()],
        FARM_PROGRAM_ID
      );

      return userStakingAddress;
    });

    const usersState = (await chunkedFetchMultipleUserAccount(
      program,
      userStakingPda,
      100
    )) as Array<UserState>;
    return usersState.reduce((acc, userState) => {
      const userStaked = userState.balanceStaked;
      if (userStaked.isZero()) return acc;
      acc.set(userState.pool.toBase58(), userStaked);
      return acc;
    }, new Map<string, BN>());
  }

  public static async claimAll(
    connection: Connection,
    owner: PublicKey,
    farmMints: Array<PublicKey>,
    opt?: {
      cluster?: Cluster;
    }
  ) {
    const { program } = getFarmProgram(connection);

    const userBalanceMap = await PoolFarmImpl.getUserBalances(
      connection,
      owner,
      farmMints
    );
    const farmMintWithBalance = Array.from(userBalanceMap.keys()).map(
      (farmMint) => new PublicKey(farmMint)
    );

    const poolFarmsImpl = await PoolFarmImpl.createMultiple(
      connection,
      farmMintWithBalance,
      { cluster: opt?.cluster }
    );

    const claimAllIxs = await Promise.all(
      poolFarmsImpl.map(async (poolFarmImpl) => {
        return (await poolFarmImpl.claimMethodBuilder(owner)).instruction();
      })
    );

    const chunkedClaimAllIx = chunks(claimAllIxs, MAX_CLAIM_ALL_ALLOWED);

    return Promise.all(
      chunkedClaimAllIx.map(async (claimAllIx) => {
        return new Transaction({
          feePayer: owner,
          ...(await program.provider.connection.getLatestBlockhash(
            "finalized"
          )),
        })
          .add(...claimAllIx)
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      })
    );
  }

  getUserPda(owner: PublicKey) {
    const [userPda] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), this.address.toBuffer()],
      this.program.programId
    );

    return userPda;
  }

  async getUserState(owner: PublicKey) {
    const userPda = this.getUserPda(owner);

    return this.program.account.user.fetchNullable(owner);
  }

  private async createUserInstruction(owner: PublicKey) {
    const userPda = this.getUserPda(owner);

    const userState = await this.getUserState(userPda);

    if (userState) return undefined;

    return await this.program.methods
      .createUser()
      .accounts({
        owner,
        pool: this.address,
        user: userPda,
      })
      .instruction();
  }

  public async deposit(owner: PublicKey, amount: BN) {
    const userPda = this.getUserPda(owner);

    const instructions: TransactionInstruction[] = [];

    const userCreateInstruction = await this.createUserInstruction(owner);
    userCreateInstruction && instructions.push(userCreateInstruction);

    const [userStakingATA, userStakingIx] = await getOrCreateATAInstruction(
      this.poolState.stakingMint,
      owner,
      this.program.provider.connection
    );
    userStakingIx && instructions.push(userStakingIx);

    const depositTx = await this.program.methods
      .deposit(amount)
      .accounts({
        owner,
        user: userPda,
        pool: this.address,
        stakeFromAccount: userStakingATA,
        stakingVault: this.poolState.stakingVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(instructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(
        "finalized"
      )),
    }).add(depositTx);
  }

  public async withdraw(owner: PublicKey, amount: BN) {
    const userPda = this.getUserPda(owner);

    const instructions: TransactionInstruction[] = [];
    const [userStakingATA, userStakingIx] = await getOrCreateATAInstruction(
      this.poolState.stakingMint,
      owner,
      this.program.provider.connection
    );
    userStakingIx && instructions.push(userStakingIx);

    const withdrawTx = await this.program.methods
      .withdraw(amount)
      .accounts({
        owner,
        pool: this.address,
        stakeFromAccount: userStakingATA,
        stakingVault: this.poolState.stakingVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        user: userPda,
      })
      .preInstructions(instructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(
        "finalized"
      )),
    }).add(withdrawTx);
  }

  private async claimMethodBuilder(owner: PublicKey) {
    const userPda = this.getUserPda(owner);

    const isDual = !this.poolState.rewardAMint.equals(
      this.poolState.rewardBMint
    );

    const preInstructions: TransactionInstruction[] = [];

    const [[userRewardAATA, userRewardAIx], [userRewardBATA, userRewardBIx]] =
      await Promise.all(
        isDual
          ? [
              getOrCreateATAInstruction(
                this.poolState.rewardAMint,
                owner,
                this.program.provider.connection
              ),
              getOrCreateATAInstruction(
                this.poolState.rewardBMint,
                owner,
                this.program.provider.connection
              ),
            ]
          : [
              getOrCreateATAInstruction(
                this.poolState.rewardAMint,
                owner,
                this.program.provider.connection
              ),
              [undefined, undefined],
            ]
      );
    userRewardAIx && preInstructions.push(userRewardAIx);
    userRewardBIx && preInstructions.push(userRewardBIx);

    return this.program.methods
      .claim()
      .accounts({
        owner,
        pool: this.address,
        rewardAAccount: userRewardAATA,
        rewardBAccount: isDual ? userRewardBATA : userRewardAATA,
        rewardAVault: this.poolState.rewardAVault,
        rewardBVault: this.poolState.rewardBVault,
        stakingVault: this.poolState.stakingVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        user: userPda,
      })
      .preInstructions(preInstructions);
  }

  public async claim(owner: PublicKey) {
    const claimTx = await (await this.claimMethodBuilder(owner)).transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(
        "finalized"
      )),
    }).add(claimTx);
  }

  async getClaimableReward(owner: PublicKey) {
    if (!this.eventParser) throw "EventParser not found";

    const claimMethodBuilder = await this.claimMethodBuilder(owner);

    const claimTransaction = await claimMethodBuilder.transaction();

    if (!claimTransaction) return;

    const blockhash = (
      await this.program.provider.connection.getLatestBlockhash("finalized")
    ).blockhash;
    const claimTx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: SIMULATION_USER,
    });
    claimTransaction && claimTx.add(claimTransaction);

    const tx = await this.program.provider.connection.simulateTransaction(
      claimTx
    );

    const simulatedReward = (await parseLogs(
      this.eventParser,
      tx?.value?.logs ?? []
    )) as { amountA: BN; amountB: BN };

    return simulatedReward;
  }
}
