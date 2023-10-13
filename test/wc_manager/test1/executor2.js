const { WitnessCalculatorComponent } = require("../../../src/witness_calculator_component.js");

const log = require("../../../logger.js");

module.exports = class Executor2 extends WitnessCalculatorComponent {
    constructor(proofmanagerAPI) {
        super("Executor2", proofmanagerAPI);
    }

    async witnessComputation(stageId, airCtx, airInstanceId) {
        return new Promise(async (resolve) => {
            log.info(`[${this.name}]`, `Starting stageId: ${stageId}, airCtx: ${airCtx}, airInstanceId: ${airInstanceId}`);

            const tasks = this.getPendingTasksByRecipient(this.name);

            for(const task of tasks) {
                log.info(`[${this.name}]`, `Resolving task: ${task.taskId}`);                
                this.resolvePendingTask(task.taskId);
            }

            log.info(`[${this.name}]`, "Finishing");
            resolve();
        });
    }
}