const {
    WITNESS_ROUND_FULLY_DONE,
    WITNESS_ROUND_NOTHING_TO_DO,
    WitnessCalculatorComponent
} = require("../../../src/witness_calculator_component.js");

const log = require("../../../logger.js");

class ExecutorSimple4 extends WitnessCalculatorComponent {
    constructor(proofmanagerAPI) {
        super("WCSimple4", proofmanagerAPI);
    }

    async witnessComputation(stageId, airInstanceCtx) {
        if(stageId !== 1) return WITNESS_ROUND_NOTHING_TO_DO;

        const airCtx = airInstanceCtx.airCtx;
        const air = this.proofmanagerAPI.getPilout().getAirBySubproofIdAirId(airCtx.subproofCtx.subproofId, airCtx.airId);

        const N = air.numRows;
        const F = airCtx.subproofCtx.F;
        
        for (let i = 0; i < N; i++) {
            const v = BigInt(i);

            airInstanceCtx.cmmtPols.Simple4.a[i] = v;
            airInstanceCtx.cmmtPols.Simple4.b[i] = F.square(v);
        }
        
        return WITNESS_ROUND_FULLY_DONE;
    }
}

module.exports = ExecutorSimple4;