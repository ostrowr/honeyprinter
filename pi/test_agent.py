import io
import json
import unittest
import agent


class AgentTests(unittest.TestCase):
    def test_durable_accept_deduplication_and_rate_limit(self):
        db = agent.open_db(':memory:')
        def message(i):
            return {'lease_id':str(i), 'body':{'type':'receipt','receipt_id':str(i),'created_at_ms':i,
                    'summary':{'title':'Hello\x1b world','body':'A connection.', 'highlights':[]}}}
        self.assertEqual(len(agent.accept(db, [message(1), message(1), message(2)])), 3)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0], 2)
        output = io.StringIO()
        self.assertTrue(agent.print_one(db, 1000, output))
        self.assertFalse(agent.print_one(db, 1059, output))
        self.assertTrue(agent.print_one(db, 1060, output))
        self.assertNotIn('\x1b', output.getvalue())
        self.assertFalse(agent.print_one(db, 1120, output))

    def test_failed_output_is_held_not_automatically_repeated(self):
        class BrokenOutput:
            def write(self, value):
                raise OSError('printer disconnected')
        db = agent.open_db(':memory:')
        receipt = {'type':'receipt','receipt_id':'x','created_at_ms':0,'summary':{'title':'Hello','body':'Test','highlights':[]}}
        agent.accept(db,[{'lease_id':'x','body':json.dumps(receipt)}])
        with self.assertRaises(OSError):
            agent.print_one(db, 1000, BrokenOutput())
        self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0], 'printing')
        self.assertFalse(agent.print_one(db, 2000, io.StringIO()))


if __name__ == '__main__':
    unittest.main()
