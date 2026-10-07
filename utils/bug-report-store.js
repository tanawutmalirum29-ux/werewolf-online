// Small shared inbox; separate DynamoDB items avoid the 400 KB item limit.
function createBugReportStore({ client, table, QueryCommand, PutCommand, DeleteCommand, GetCommand, enabled = true }) {
    const partition = '__BUG_REPORTS__';
    const key = report => ({ playerName: partition, statKey: `${report.createdAt}#${report.id}` });
    return {
        enabled,
        async list(limit = 200) {
            if (!enabled) return [];
            const doc = await client(), reports = [];
            let cursor;
            do {
                const result = await doc.send(new QueryCommand({
                    TableName: table, KeyConditionExpression: 'playerName = :partition',
                    ExpressionAttributeValues: { ':partition': partition },
                    ScanIndexForward: false, ConsistentRead: true,
                    Limit: limit - reports.length, ExclusiveStartKey: cursor,
                }));
                reports.push(...(result.Items || []).map(item => item.report).filter(Boolean));
                cursor = result.LastEvaluatedKey;
            } while (cursor && reports.length < limit);
            return reports.slice(0, limit);
        },
        async find(report) {
            if (!enabled) return null;
            const doc = await client();
            const result = await doc.send(new GetCommand({ TableName:table, Key:key(report), ConsistentRead:true }));
            return result.Item?.report || null;
        },
        async save(report) {
            if (!enabled) return;
            const doc = await client();
            await doc.send(new PutCommand({ TableName: table, Item: {
                ...key(report), report, expiresAt: Math.floor(Date.parse(report.createdAt) / 1000) + 30 * 86400,
            } }));
        },
        async remove(report) {
            if (!enabled) return;
            const doc = await client();
            await doc.send(new DeleteCommand({ TableName: table, Key: key(report) }));
        },
    };
}
module.exports = { createBugReportStore };
