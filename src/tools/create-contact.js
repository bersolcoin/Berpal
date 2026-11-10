const counterparties = require('../counterparties');

const definition = {
  name: 'create_contact',
  description:
    'Add a contact (person/business the user trades with). Returns the contact id; existed=true if one with that name was already on file (it is updated, not duplicated).',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      nickname: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
    },
  },
};

async function execute(args, ctx) {
  return counterparties.createContact(ctx.user, args);
}

module.exports = { definition, execute };
