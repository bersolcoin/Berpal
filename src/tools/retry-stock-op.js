const definition = {
  name: 'retry_stock_op',
  description:
    'Finish the stock operation that was only partly saved (or only partly undone). Call when the user says retry / try again / finish it after a save that reported partial: true, or when a tool says a stock operation is not finished. It posts only what the user already confirmed; no new card is needed.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  return require('../lots/gate').retry(ctx);
}

module.exports = { definition, execute, niche: 'gems' };
