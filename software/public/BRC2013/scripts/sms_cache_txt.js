/**
 * sms_cache_txt.js
 * This file is based on the YATE Project http://YATE.null.ro
 *
 * SIP SMS caching proxy to text/plain SMSC implemented in Javascript
 *
 * Yet Another Telephony Engine - a fully featured software PBX and IVR
 * Copyright (C) 2012 Null Team
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA.
 */

// Defaults that can be overridden by config
is_online = true;
is_congested = false;
max_queued = 30;
sms_attempts = 10;
retry_time = sqlStr("00:02:00");
debug = false;

#require "bman.js"
#require "libsql.js"


// Convert a number to MSISDN (international format)
function toMSISDN(num,cc,ton)
{
    switch (ton) {
	case 0x11:
	case "international":
	    return num;
	case 0x21:
	case "national":
	    // ISDN national
	    return cc + num;
    }
    switch (num) {
	case %+.%:
	    // E.164 +CCNNNN
	    return num.substr(1);
	case %00.%:
	    // ITU 00CCNNNN
	    return num.substr(2);
	case %011.%:
	    // USA 011CCNNNN
	    return num.substr(3);
	case %0z.%:
	    // 0NNNN various national
	    return cc + num.substr(1);
	case %z.%:
	    // NNNN various national
	    return cc + num;
    }
    return null;
}

// Perform one command line completion
function oneCompletion(msg,str,part)
{
    if (part != "" && str.indexOf(part) != 0)
	return;
    var ret = msg.retValue();
    if (ret != "")
	ret += "\t";
    msg.retValue(ret + str);
}

/* vi: set ts=8 sw=4 sts=4 noet: */

// Deliver SMS to registered MS
function localDelivery(id,location)
{
    var res = rowQuery("SELECT imsi,msisdn,dest,msg FROM text_sms WHERE tries > 0 AND id=" + sqlNum(id));
    if (!res)
	return null;
    sqlQuery("UPDATE text_sms SET tries=tries-1,next_try=ADDTIME(NOW()," + retry_time + ") WHERE id=" + sqlNum(id));

    var m = new Message("xsip.generate");
    m.method = "MESSAGE";
    m.uri = location.substr(4);
    m.user = res.msisdn;
    //m.user = "+" + res.msisdn;
    if (my_sip)
	m.domain = my_sip;
    m.xsip_type = "text/plain";
    m.xsip_body = res.msg;
    m.wait = true;
    if (m.dispatch(true)) {
	switch (m.code) {
	    case 200:
	    case 202:
		sqlQuery("UPDATE text_sms SET next_try=NOW(),tries=-1 WHERE id=" + id);
		return;
	}
    }
}

// Deliver SMS to upstream SMSC
function smscDelivery(id)
{
    var res = rowQuery("SELECT imsi,msisdn,dest,msg FROM text_sms WHERE tries > 0 AND id=" + sqlNum(id));
    if (!res)
	return;
    sqlQuery("UPDATE text_sms SET tries=tries-1,next_try=ADDTIME(NOW()," + retry_time + ") WHERE id=" + sqlNum(id));

    var m = new Message("xsip.generate");
    m.method = "MESSAGE";
    m.uri = "sip:" + res.dest + "@" + vlr_sip;
    //m.uri = "sip:+" + res.dest + "@" + vlr_sip;
    m.user = "IMSI" + res.imsi;
    if (my_sip)
	m.domain = my_sip;
    m.xsip_type = "text/plain";
    m.xsip_body = res.msg;
    m.wait = true;
    if (m.dispatch(true)) {
	switch (m.code) {
	    case 200:
	    case 202:
		// Success
		sqlQuery("UPDATE text_sms SET next_try=NOW(),tries=-1 WHERE id=" + id);
		return;
	    case 403:
	    case 404:
	    case 415:
	    case 488:
		// Terminal failure
		Engine.debug(Engine.DebugWarn,"Failed to submit SMS with ID=" + id + ", code=" + m.code);
		sqlQuery("UPDATE text_sms SET next_try=NOW(),tries=-3 WHERE id=" + id);
		return;
	}
    }
}

// MO SMS handling
function moSipSms(msg,imsi)
{
	Engine.debug(Engine.DebugAll,"imsi '" + imsi );
    // IMSI here is the IMSi of the sender.

    // Don't allow sending without a return path.
    var simsi = sqlStr(imsi);
    var msisdn = valQuery("SELECT msisdn FROM register WHERE imsi=" + simsi);
    if (msisdn == "") {
	msg.retValue(403); // forbidden
	return true;
    }
    // Limit the number of messages queued for each user.
    if (max_queued) {
	// Limit the number of messages waiting in MO queue
	var cnt = valQuery("SELECT COUNT(*) FROM text_sms WHERE imsi=" + simsi);
	if (cnt >= max_queued) {
	    msg.retValue(480); // temporarily unavailable
	    return true;
	}
    }
//    var dest = toMSISDN(msg.called,my_cc);
    var dest = msg.called;
    if (debug)
	Engine.debug(Engine.DebugAll,"MO SMS '" + imsi + "' (" + msisdn + ") -> '" + dest + "'");
	//Engine.debug(Engine.DebugAll,"MO SMS '" + imsi + "' (+" + msisdn + ") -> '" + dest + "'");
    var isLocal = !!valQuery("SELECT COALESCE(location) AS location FROM register WHERE msisdn=" + sqlStr(dest));
    var when = "ADDTIME(NOW()," + retry_time + ")";
    if (isLocal)
	when = "NOW()";
    var query = "INSERT INTO text_sms(imsi,msisdn,dest,next_try,tries,msg)";
    query += " VALUES(" + simsi + "," + sqlStr(msisdn) + ","
	+ sqlStr(dest) + "," + when + "," + sqlNum(sms_attempts) + ","
	+ sqlStr(msg.xsip_body) + ")";
    query += "; SELECT LAST_INSERT_ID()";
    var id = valQuery(query);
    if (!id) {
	msg.retValue(500); // internal server error
	return true;
    }

    msg.retValue(202); // accepted
    if (isLocal || is_congested || !is_online)
	return true;

    // if we're online and not congested attempt immediate submission
    var m = new Message("xsip.generate");
    m.method = "MESSAGE";
    m.uri = "sip:" + dest + "@" + vlr_sip;
    //m.uri = "sip:+" + dest + "@" + vlr_sip;
    m.user = msg.caller;
    if (my_sip)
	m.domain = my_sip;
    m["sip_P-PHY-Info"] = msg["sip_p-phy-info"];
    m["sip_P-Access-Network-Info"] = msg["sip_p-access-network-info"];
    m.xsip_type = msg.xsip_type;
    m.xsip_body = msg.xsip_body;
    m.wait = true;
    if (m.dispatch(true)) {
	switch (m.code) {
	    case undefined:
	    case null:
	    case "":
	    case 0:
	    case 408:
	    case 504:
		// Timeout or some other local failure
		return true;
	    case 200:
	    case 202:
		// Success
		sqlQuery("UPDATE text_sms SET next_try=NOW(),tries=-1 WHERE id=" + id);
		// Intentionally fall through
	    default:
		if (m.code > 299)
		    sqlQuery("UPDATE text_sms SET next_try=NOW(),tries=-3 WHERE id=" + id);
		msg.retValue(m.code);
		if (m.xsip_body) {
		    msg.xsip_type = m.xsip_type;
		    msg.xsip_body = m.xsip_body;
		}
	    return true;
	}
    }
    return true;
}

// MT SMS are forwarded directly to OpenBTS
function mtSipSms(msg,imsi)
{
    var res = rowQuery("SELECT COALESCE(location) AS location,msisdn FROM register WHERE imsi=" + sqlStr(imsi));
    if (res) {
	if (debug)
	    Engine.debug(Engine.DebugAll,"MT SMS '" + msg.caller + "' -> '" + imsi + "' (" + res.msisdn + ")");
	    //Engine.debug(Engine.DebugAll,"MT SMS '" + msg.caller + "' -> '" + imsi + "' (+" + res.msisdn + ")");
	var m = new Message("xsip.generate");
	m.method = "MESSAGE";
	m.uri = res.location.substr(4);
	m.user = msg.caller;
	if (my_sip)
	    m.domain = my_sip;
	m.xsip_type = msg.xsip_type;
	m.xsip_body = msg.xsip_body;
	m.wait = true;
	if (m.dispatch(true)) {
	    msg.retValue(m.code);
	    if (m.xsip_body) {
		msg.xsip_type = m.xsip_type;
		msg.xsip_body = m.xsip_body;
	    }
	    return true;
	}
	msg.retValue(503); // service unavailable
	return true;
    }
    msg.retValue(404); // not found
    return true;
}

// Handle SIP SMS
function onSipMessage(msg)
{
    if (msg.caller == "" || msg.called == "")
	return false;
    if (msg.xsip_type != "text/plain" || msg.xsip_body == "") {
	msg.retValue(415); // unsupported media type
	return true;
    }

    if (msg.called.length == 4 || msg.called.length == 3 || msg.called.length >= 8) 
	 	return  tropo(msg);
    if (msg.called.length == 7 && msg.caller.substr(0,4) != "IMSI") 
	    	return local(msg);
    else if (msg.caller.substr(0,4) == "IMSI")
	return moSipSms(msg,msg.caller.substr(4));
    else if (msg.called.substr(0,4) == "IMSI")
	return mtSipSms(msg,msg.called.substr(4));
    msg.retValue(488); // not acceptable here
    return true;
}

function local (msg)
{
	query = "SELECT imsi FROM register WHERE msisdn=" + sqlStr(msg.called);
	res = rowQuery(query);
	mtSipSms(msg,res.imsi);

}
function tropo (msg)
{
	var tmp = msg.caller.substr(4);
	// Set the caller ID
	if (msg.caller.match(/IMSI/)) {
		query = "SELECT msisdn FROM register WHERE imsi=" + sqlStr(msg.caller.substr(4));
		res = rowQuery(query);
		if (res) { 
			msg.caller = res.msisdn;
			msg.callername =  res.msisdn;
			//msg.caller = "+" + res.msisdn;
			//msg.callername = "+" + res.msisdn;
		}
	}
	moSipSms(msg,tmp)

}

// Run expiration and retries
function onInterval()
{
    var when = Date.now() / 1000;
    if (onInterval.nextIdle >= 0 && when >= onInterval.nextIdle) {
	onInterval.nextIdle = -1;
	var m = new Message("idle.execute");
	m.module = "sms_cache";
	if (!m.enqueue())
	    onInterval.nextIdle = when + 5;
    }
}

// Execute idle loop actions
function onIdleAction()
{
    // Perform local delivery if possible
    var query = "SELECT id,COALESCE(location) AS location FROM register,text_sms WHERE register.msisdn=text_sms.dest"
	+ " AND location IS NOT NULL AND tries > 0 AND next_try IS NOT NULL AND NOW() > next_try"
	+ " ORDER BY next_try,id LIMIT 1";
    var res = rowQuery(query);
    if (res)
	localDelivery(res.id,res.location);
    else if (is_online) {
	query = "SELECT id FROM text_sms WHERE tries > 0 AND next_try IS NOT NULL AND NOW() > next_try"
	    + " ORDER BY next_try,id LIMIT 1";
	res = valQuery(query);
	if (res)
	    smscDelivery(res);
    }
    // Reschedule after 5s
    onInterval.nextIdle = (Date.now() / 1000) + 5;
}

// Handle cache state changes
function onCacheState(msg)
{
    is_online = msg.online;
    is_congested = msg.congestion;
    return false;
}

// Perform completion of partial command lines
function onComplete(msg,line,part)
{
    switch (line) {
	case undefined:
	case "":
	case "help":
	    oneCompletion(msg,"smsc",part);
	    break;
	case "smsc":
	    oneCompletion(msg,"list",part);
	    oneCompletion(msg,"drop",part);
	    oneCompletion(msg,"debug",part);
	    break;
	case "smsc drop":
	    var res = sqlQuery("SELECT imsi FROM text_sms GROUP BY imsi");
	    if (!res)
		break;
	    for (var i = 0; ; i++) {
		var user = res.getResult(i,0);
		if (user === null)
		    break;
		Engine.output("Completing: " + user);
		oneCompletion(msg,user,part);
	    }
	    break;
	case "smsc debug":
	    oneCompletion(msg,"on",part);
	    oneCompletion(msg,"off",part);
	    break;
    }
}

// Handle rmanager commands
function onCommand(msg)
{
    if (!msg.line) {
	onComplete(msg,msg.partline,msg.partword);
	return false;
    }
    switch (msg.line) {
	case "smsc list":
	    var res = sqlQuery("SELECT msisdn,dest,imsi,tries,TIMEDIFF(next_try,NOW()) AS next FROM text_sms WHERE tries > 0");
	    if (res) {
		res = res.getRow();
		var tmp = "IMSI            Originator      Destination     Retries Retry in\r\n";
		tmp += "--------------- --------------- --------------- ------- ---------\r\n";
		for (var i = 0; i < res.length; i++) {
		    var rec = res[i];
		    var nxt = rec.next;
		    tmp += strFix(rec.imsi,15) + " " + strFix(rec.msisdn,15) + " "
			+ strFix(rec.dest,15) + " " + strFix(rec.tries,-7) + " " + strFix(nxt,-9) + "\r\n";
		}
		msg.retValue(tmp);
	    }
	    else
		msg.retValue("Database error!\r\n");
	    return true;
	case /^smsc debug ./:
	    switch (msg.line.substr(11)) {
		case "true":
		case "yes":
		case "on":
		    debug = true;
		    msg.retValue("SMS Cache Debug enabled\r\n");
		    return true;
		case "false":
		case "no":
		case "off":
		    msg.retValue("SMS Cache Debug disabled\r\n");
		    debug = false;
		    return true;
	    }
    }
    return false;
}

csmsHelp = "  smsc [list|drop ID|debug on/off]\r\n";

// Provide help for rmanager command line
function onHelp(msg)
{
    if (msg.line) {
	if (msg.line == "smsc") {
	    msg.retValue(csmsHelp + "Control the SMS Cache operation\r\n");
	    return true;
	}
	return false;
    }
    msg.retValue(msg.retValue() + csmsHelp);
    return false;
}

Engine.debugName("sms_cache");
Message.trackName("sms_cache");
Message.install(onCommand,"engine.command",120);
Message.install(onHelp,"engine.help",150);
Message.install(onSipMessage,"sip.message",100);
Message.install(onCacheState,"cache.status",100);
Message.install(onIdleAction,"idle.execute",110,"module","sms_cache");
Engine.setInterval(onInterval,1000);

var m = new Message("cache.query");
if (m.dispatch()) {
    is_online = m.online;
    is_congested = m.congestion;
}

/* vi: set ts=8 sw=4 sts=4 noet: */
