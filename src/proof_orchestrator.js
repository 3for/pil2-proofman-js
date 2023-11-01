const WitnessCalculatorManager = require("./witness_calculator_manager.js");
const {
    ProversManager,
    PROVER_OPENINGS_COMPLETED,
    PROVER_OPENINGS_PENDING,
} = require("./provers_manager.js");

const { AirOut } = require("./airout.js");
const ProofCtx = require("./proof_ctx.js");

const { fileExists } = require("./utils.js");
const path = require("path");

const FiniteFieldFactory = require("./finite_field_factory.js");

const log = require("../logger.js");
const { callCalculateExps } = require("pil2-stark-js/src/prover/prover_helpers.js");

module.exports = class ProofOrchestrator {
    constructor(name) {
        this.initialized = false;

        this.name = name ?? "Proof Orch";
    }

    checkInitialized() {
        if(!this.initialized) {
            log.error(`[${this.name}]`, `Not initialized.`);
            throw new Error(`[ProofOrchestrator] Not initialized.`);
        }
    }

    async initialize(config, options) {
        if (this.initialized) {
            log.error(`[${this.name}]`, "Already initialized.");
            throw new Error(`[${this.name}] Proof Orchestrator already initialized.`);
        }

        log.info(`[${this.name}]`, "> Initializing...");

        this.options = options;

        /*
         * config is a JSON object containing the following fields:
         * - name: name of the proof
         * - airout: airout of the proof
         * - witnessCalculators: array of witnessCalculator types
         * - prover: prover 
         * - setup: setup data
         */
        if (!await configValid(config)) {
            log.error(`[${this.name}]`, "Invalid proof orchestrator config.");
            throw new Error("Invalid proof orchestrator config.");
        }
        this.config = config;

        const airout = new AirOut(this.config.airout.filename);

        // Create the finite field object
        const finiteField = FiniteFieldFactory.createFiniteField(airout.baseField);
        this.proofCtx = ProofCtx.createProofCtxFromAirout(this.config.name, airout, finiteField);
        
        this.wcManager = new WitnessCalculatorManager();
        await this.wcManager.initialize(config.witnessCalculators, this.proofCtx, this.options);

        this.proversManager = new ProversManager();
        await this.proversManager.initialize(config.prover, this.proofCtx, this.options);

        this.initialized = true;
        
        return;

        async function configValid(config) {
            const fields = ["airout", "witnessCalculators", "prover"];
            for (const field of fields) {
                if (config[field] === undefined) {
                    log.error(`[${this.name}]`, `No ${field} provided in config.`);
                    return false;
                }
            }

            if (config.name === undefined) {
                config.name = "proof-" + Date.now();
                log.warn(`[${this.name}]`, `No name provided in config, assigning a default name ${config.name}.`);
            }

            if (config.witnessCalculators.length === 0) {
                log.error(`[${this.name}]`, "No witnessCalculators provided in config.");
                return false;
            }
    
            if (!await validateFileNameCorrectness(config)) {
                log.error(`[${this.name}]`, "Invalid config.");
                return false;
            }
    
            //TODO !!!!
            /// If setup exists check that it has a valid format

            return true;
        }

        async function validateFileNameCorrectness(config) {
            const airoutFilename =  path.join(__dirname, "..", config.airout.airoutFilename);
            if (!await fileExists(airoutFilename)) {
                log.error(`[${this.name}]`, `Airout ${airoutFilename} does not exist.`);
                return false;
            }
            config.airout.filename = airoutFilename;
            console.log(airoutFilename, config.airout.airoutFilename);


            for(const witnessCalculator of config.witnessCalculators) {
                const witnessCalculatorLib =  path.join(__dirname, "..", witnessCalculator.filename);

                if (!await fileExists(witnessCalculatorLib)) {
                    log.error(`[${this.name}]`, `WitnessCalculator ${witnessCalculator.filename} does not exist.`);
                    return false;
                }
                witnessCalculator.witnessCalculatorLib = witnessCalculatorLib;
            }                
    
            const proverFilename =  path.join(__dirname, "..", config.prover.filename);

            if (!await fileExists(proverFilename)) {
                log.error(`[${this.name}]`, `Prover ${proverFilename} does not exist.`);
                return false;
            }
            config.prover.proverFilename = proverFilename;

            if (config.setup !== undefined) {
                // TODO
            }

            return true;
        }
    }

    async newProof(publics) {
        await this.proofCtx.initialize(publics);
    }

    async verifyPilGlobalConstraints() {
        this.proofCtx.errors = [];

        if(this.proofCtx.constraintsCode !== undefined) {
            for(let i =  0; i < this.proofCtx.constraintsCode.length; i++) {
                const constraint = this.proofCtx.constraintsCode[i];
                log.info(`··· Checking global constraint ${i + 1}/${this.proofCtx.constraintsCode.length}: ${constraint.line} `);
                await callCalculateExps("global", constraint, "n", this.proofCtx, this.options.parallelExec, this.options.useThreads, true, true);
            }
        }


        const isValid = this.proofCtx.errors.length === 0;
        
        if (!isValid) {
            log.error(`[${this.name}]`, `PIL constraints have not been fulfilled!`);
            for (let i = 0; i < this.proofCtx.errors.length; i++) log.error(`[${this.name}]`, this.proofCtx.errors[i]);
        }

        return isValid;
    }

    async generateProof(setup, publics) {
        this.checkInitialized();

        let result;
        try {
            if(this.options.onlyCheck === undefined || this.options.onlyCheck === false) {
                log.info(`[${this.name}]`, `==> STARTING GENERATION OF THE PROOF '${this.config.name}'.`);
            }

            await this.newProof(publics);

            let proverStatus = PROVER_OPENINGS_PENDING;
            for (let stageId = 1; proverStatus !== PROVER_OPENINGS_COMPLETED; stageId++) {
                let str = stageId <= this.proofCtx.airout.numStages + 1 ? "STAGE" : "OPENINGS";
                log.info(`[${this.name}]`, `==> ${str} ${stageId}`);

                await this.wcManager.witnessComputation(stageId, publics);

                if (stageId === 1) {} await this.proversManager.setup(setup);

                proverStatus = await this.proversManager.computeStage(stageId, publics, this.options);

                log.info(`[${this.name}]`, `<== ${str} ${stageId}`);

                if(stageId === this.proofCtx.airout.numStages) {
                    for(let i = 0; i < this.proofCtx.airout.subproofs.length; i++) {
                        const subproof = this.proofCtx.airout.subproofs[i];
                        const subproofValues = subproof.subproofvalues;
                        if(subproofValues === undefined) continue;
                        const instances = this.proofCtx.airInstances.filter(airInstance => airInstance.subproofId === i);
                        for(let j = 0; j < subproofValues.length; j++) {
                            const aggType = subproofValues[j].aggType;
                            for(let k = 0; k < instances.length; k++) {
                                const subproofValue = instances[k].ctx.subproofValues[j];
                                this.proofCtx.subproofValues[i][j] = aggType === 0 
                                    ? this.proofCtx.F.add(this.proofCtx.subproofValues[i][j], subproofValue) 
                                    : this.proofCtx.F.mul(this.proofCtx.subproofValues[i][j], subproofValue);
                            }
                        }
                    }
                }

                // If onlyCheck is true, we check the constraints stage by stage from stage1 to stageQ - 1 and do not generate the proof
                if(this.options.onlyCheck) {
                    log.info(`[${this.name}]`, `==> CHECKING CONSTRAINTS STAGE ${stageId}`);
                    result = true;
                    for (const airInstance of this.proofCtx.airInstances) {
                        const proverId = this.proversManager.getProverIdFromInstance(airInstance);
        
                        result = result && await this.proversManager.provers[proverId].verifyPil(stageId, airInstance);
        
                        if (result === false) {
                            log.error(`[${this.name}]`, `PIL verification failed for subproof ${airInstance.subproofId} and air ${airInstance.airId} with N=${airInstance.layout.numRows} rows.`);
                            break;
                        }
                    }
                    
                    if(result) {
                        log.info(`[${this.name}]`, `Checking constraints successfully for stage ${stageId}.`);
                        log.info(`[${this.name}]`, `<== CHECKING CONSTRAINTS STAGE ${stageId}`);
                    } else {
                        log.error(`[${this.name}]`, `PIL verification failed at stage ${stageId}.`);
                        log.error(`[${this.name}]`, `<== CHECKING CONSTRAINTS STAGE ${stageId}`);
                        throw new Error(`[${this.name}]`, `PIL verification failed at stage ${stageId}.`);
                    }

                    if(stageId === this.proofCtx.airout.numStages) {
                        const valid = await this.verifyPilGlobalConstraints();
                        if(!valid) {
                            log.error(`[${this.name}]`, `PIL verification failed for proof.`);
                            break;
                        }
                        log.info(`[${this.name}]`, `<== CONSTRAINTS SUCCESSFULLY FULLFILLED.`);
                        return result;
                    }
                }
            }

            log.info(`[${this.name}]`, `<== PROOF '${this.config.name}' SUCCESSFULLY GENERATED.`);

            let proofs = [];
    
            for(const airInstance of this.proofCtx.airInstances) {
                airInstance.proof.subproofId = airInstance.subproofId;
                airInstance.proof.airId = airInstance.airId;
                proofs.push(airInstance.proof);
            }
    
            return {
                proofs,
                challenges: this.proofCtx.challenges.slice(0, this.proofCtx.airout.numStages + 3),
                challengesFRISteps: this.proofCtx.challenges.slice(this.proofCtx.airout.numStages + 3).map(c => c[0]),
                subproofValues: this.proofCtx.subproofValues,
            };

        } catch (error) {
            log.error(`[${this.name}]`, `Error while generating proof: ${error}`);
            throw error;
        }
    }
}
