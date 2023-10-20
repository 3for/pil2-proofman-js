const ProverComponent = require("../../prover.js");
const { PROVER_OPENINGS_COMPLETED, PROVER_OPENINGS_PENDING } = require("../../provers_manager.js");
const starkSetup = require("pil2-stark-js/src/stark/stark_setup.js");
const starkGen = require("pil2-stark-js/src/stark/stark_gen.js");
const { initProverStark,
    computeEvalsStark,
    computeFRIStark,
    genProofStark,
    setChallengesStark,
    calculateChallengeStark,
    extendAndMerkelize,
    getPermutationsStark,
    computeFRIFolding,
    computeFRIQueries,
    computeQStark,
    addTranscriptStark,
    getChallengeStark,
} = require("pil2-stark-js/src/stark/stark_gen_helpers.js");
const {
    calculatePublics,
    callCalculateExps,
    applyHints,
} = require("pil2-stark-js/src/prover/prover_helpers.js");

const pilInfo = require("pil2-stark-js/src/pil_info/pil_info.js");
const { newConstantPolsArrayPil2 } = require("pilcom/src/polsarray.js");
const { getFixedPolsPil2 } = require("pil2-stark-js/src/pil_info/helpers/pil2/piloutInfo.js");

const path = require("path");

const log = require('../../../logger.js');

class StarkFriProver extends ProverComponent {
    constructor(proofmanagerAPI) {
        super("FRI Prover", proofmanagerAPI);
    }

    initialize(settings, options) {
        super.initialize(settings, options);

        this.options.logger = log;

        const starkStructFilename =  path.join(__dirname, "../../..",  settings.starkStruct);
        this.starkStruct = require(starkStructFilename);
    }

    async setup(airCtx) {
        const subproofCtx = airCtx.subproofCtx;
        const airout = this.proofmanagerAPI.getAirout().airout;
        const airSymbols = airout.symbols.filter(symbol => symbol.subproofId === subproofCtx.subproofId && symbol.airId === airCtx.airId);

        const air = this.proofmanagerAPI.getAirout().getAirBySubproofIdAirId(subproofCtx.subproofId, airCtx.airId);

        airCtx.setup = {
            name: (airCtx.name ? airCtx.name : airCtx.airId) + "-" + airCtx.numRows,
            fixedPols: newConstantPolsArrayPil2(airSymbols, airCtx.numRows, subproofCtx.F)
        };

        getFixedPolsPil2(air, airCtx.setup.fixedPols, subproofCtx.F);

        const options = {
            F: subproofCtx.F,
            pil1: false,
        };

        Object.assign(airCtx.setup, await starkSetup(airCtx.setup.fixedPols, air, this.starkStruct, options));
    }

    async newProof(airCtx, publics) {
        for (const airInstanceCtx of airCtx.instances) {   
            airInstanceCtx.ctx = await initProverStark(airCtx.setup.starkInfo, airCtx.setup.fixedPols, airCtx.setup.constTree, this.options);                   
            airInstanceCtx.publics = publics;
        }
    }

    async verifyPil(subproofCtx, airId, instanceId, publics) {
        const pil1 = false;
        const stark = true;
        const debug = true;
        
        const airInstanceCtx = subproofCtx.airsCtx[airId].instances[instanceId];
        const airout = this.proofmanagerAPI.getAirout();
        const air = airout.getAirBySubproofIdAirId(subproofCtx.subproofId, airId);

        const starkInfo = pilInfo(subproofCtx.F, air, stark, pil1, debug, {});

        const verificationHashType = "GL";
        const splitLinearHash = false;
        const optionsPilVerify = {logger:log, debug, useThreads: false, parallelExec: false, verificationHashType, splitLinearHash};

        const setup = airInstanceCtx.airCtx.setup;
        return await starkGen(airInstanceCtx.wtnsPols, setup.fixedPols, {}, starkInfo, publics, optionsPilVerify);
    }

    async commitStage(stageId, airInstanceCtx) {
        this.checkInitialized();

        const airout = this.proofmanagerAPI.getAirout();
        const ctx = airInstanceCtx.ctx;

        if (stageId === 1) {
            airInstanceCtx.wtnsPols.writeToBigBuffer(ctx.cm1_n, ctx.pilInfo.mapSectionsN.cm1);
            addTranscriptStark(ctx.transcript, [ctx.MH.root(airInstanceCtx.airCtx.setup.constTree)]);
            this.calculatePublics(airInstanceCtx);
        }

        if(stageId <= airout.numStages + 1) {
            const qStage = ctx.pilInfo.numChallenges.length + 1;

            if(this.options.debug) {
                ctx.errors = [];
                if(stageId === qStage) return;
            }

            const dom = stageId === qStage ? "ext" : "n";

            await callCalculateExps(`stage${stageId}`, ctx.pilInfo.code[`stage${stageId}`], dom, ctx, this.settings.parallelExec, this.settings.useThreads, false);
        
            await applyHints(stageId, ctx);

            if(this.options.debug && stageId !== qStage) {
                const nConstraintsStage = ctx.pilInfo.constraints[`stage${stageId}`].length;

                for(let i = 0; i < nConstraintsStage; i++) {
                    const constraint = ctx.pilInfo.constraints[`stage${stageId}`][i];                    
                    log.debug(` Checking constraint ${i + 1}/${nConstraintsStage}: line ${constraint.line} `);
                    await callCalculateExps(`stage${stageId}`, constraint, dom, ctx, this.settings.parallelExec, this.settings.useThreads, true);
                }
            }
        }

        let challenge;
        if(!this.options.debug) {
            let commits = stageId === airout.numStages + 1 ? await computeQStark(ctx, log) : await extendAndMerkelize(stageId, ctx, log);

            addTranscriptStark(ctx.transcript, commits);

            challenge = getChallengeStark(ctx.transcript);
        } else {
            challenge = ctx.F.random();
        }

        airInstanceCtx.ctx.challenges[stageId] = challenge;
    }

    async calculatePublics(airInstanceCtx) {
        const ctx = airInstanceCtx.ctx;
        
        calculatePublics(ctx, airInstanceCtx.publics);

        let publicsCommits = [];

        if (this.options.hashCommits) {
            const publicsRoot = await calculateHash(ctx, ctx.publics);
            publicsCommits.push(publicsRoot);
        } else {
            publicsCommits.push(...ctx.publics);
        }

        addTranscriptStark(ctx.transcript, publicsCommits);
    }

    async openingStage(openingId, airInstanceCtx) {
        this.checkInitialized();

        const isLastRound = openingId === 2 + airInstanceCtx.ctx.pilInfo.starkStruct.steps.length + 1;
        const numStages = this.proofmanagerAPI.getAirout().numStages + 1;

        if(openingId === 1) {
            await this.computeOpenings(numStages + openingId, airInstanceCtx);
        } else if(openingId === 2) {
            await this.computeFRIStark(numStages + openingId, airInstanceCtx);
        } else if(openingId <= 2 + airInstanceCtx.ctx.pilInfo.starkStruct.steps.length) {
            await this.computeFRIFolding(numStages + openingId, airInstanceCtx, { step: openingId - 3});
        } else if(openingId === 2 + airInstanceCtx.ctx.pilInfo.starkStruct.steps.length + 1) {
            await this.computeFRIQueries(numStages + openingId, airInstanceCtx);
        } else {
            log.error(`[${this.name}]`, `Invalid openingId ${openingId}.`);
            throw new Error(`[${this.name}]`, `Invalid openingId ${openingId}.`);
        }


        return isLastRound ? PROVER_OPENINGS_COMPLETED : PROVER_OPENINGS_PENDING;
    }

    async computeAirChallenges(stageId, airInstanceCtx) {
        this.checkInitialized();

        airInstanceCtx.ctx.challenges[stageId] = await calculateChallengeStark(stageId, airInstanceCtx.ctx);
    }

    setChallenges(stageId, airInstanceCtx, challenge) {
        this.checkInitialized();

        setChallengesStark(stageId, airInstanceCtx.ctx, airInstanceCtx.ctx.transcript, challenge, log);
    }

    async computeOpenings(stageId, airInstanceCtx) {
        const ctx = airInstanceCtx.ctx;

        log.info(
            `[${this.name}]`,
            `Computing Openings for subproof ${airInstanceCtx.airCtx.subproofCtx.name} airId ${airInstanceCtx.airId} instanceId ${airInstanceCtx.instanceId}`
        );

        const challenge = this.proofmanagerAPI.getChallenge(stageId - 1);
        setChallengesStark(stageId, ctx, ctx.transcript, challenge, this.options);

        const evalCommits = await computeEvalsStark(ctx, this.options);

        addTranscriptStark(ctx.transcript, evalCommits);
        ctx.challenges[stageId] = getChallengeStark(ctx.transcript);
    }

    async computeFRIStark(stageId, airInstanceCtx) {
        const ctx = airInstanceCtx.ctx;

        log.info(
            `[${this.name}]`,
            `Computing FRI Stark for subproof ${airInstanceCtx.airCtx.subproofCtx.name} airId ${airInstanceCtx.airId} instanceId ${airInstanceCtx.instanceId}`
        );

        const challenge = this.proofmanagerAPI.getChallenge(stageId - 1);
        setChallengesStark(stageId, ctx, ctx.transcript, challenge, this.options);

        await computeFRIStark(ctx, this.options);

        ctx.challenges[stageId] = getChallengeStark(ctx.transcript);
    }

    async computeFRIFolding(stageId, airInstanceCtx, params) {
        const challenge = this.proofmanagerAPI.getChallenge(stageId - 1);
        const ctx = airInstanceCtx.ctx;

        const friCommits = await computeFRIFolding(params.step, ctx, challenge, this.options);

        addTranscriptStark(ctx.transcript, friCommits);
        ctx.challenges[stageId] = getChallengeStark(ctx.transcript);
    }

    async computeFRIQueries(stageId, airInstanceCtx, params) {
        const ctx = airInstanceCtx.ctx;

        const challenge = this.proofmanagerAPI.getChallenge(stageId - 1);
    
        const friQueries = await getPermutationsStark(ctx, challenge);

        log.debug("··· FRI queries: [" + friQueries.join(",") + "]");
    
        computeFRIQueries(ctx, friQueries);

        const airId = airInstanceCtx.airId;
        const instanceId = airInstanceCtx.instanceId;
        const subproofCtx = airInstanceCtx.airCtx.subproofCtx;
        subproofCtx.airsCtx[airId].instances[instanceId].proof = await genProofStark(airInstanceCtx.ctx, log);
    }    

}

module.exports = StarkFriProver;